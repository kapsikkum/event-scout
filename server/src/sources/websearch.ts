import { BLOCKING_HOSTS } from '../shared/skipHosts.js';
import { extractEventsFromHtml } from './jsonld.js';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';
import { expandTopics, rotateQueries, webQuery } from './topics.js';
import { BROWSER_HEADERS } from '../useragent.js';
import { assertPublicUrl, publicFetch, readCappedText } from '../nethost.js';


// DuckDuckGo's html endpoint flags the full Chrome fingerprint as a bot (a real
// Chrome would use the JS site) and returns a 202 anomaly page. A minimal UA gets
// the actual results. This is the opposite of Facebook, which needs the full one.
const MINIMAL_UA = 'Mozilla/5.0';
const PAGE_HEADERS = BROWSER_HEADERS;

const RESULTS_PER_QUERY = 8;
// Per area, per refresh. Topics rotate through the rest on later passes.
const MAX_QUERIES_PER_AREA = 12;
const QUERY_SPACING_MS = 1200;
const MAX_PAGES_TOTAL = 30;
const PAGE_TIMEOUT_MS = 12000;

// Aggregators that reliably block scrapers or never expose JSON-LD — skip to save budget.
// Ticketing sites with an adapter of their own are read through that instead.
const SKIP_HOSTS = [
  ...BLOCKING_HOSTS,
  'songkick.com',
  'bandsintown.com',
  'ticketmaster.com',
  'seatgeek.com',
];

function decodeDdgLinks(html: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
    try {
      const url = decodeURIComponent(m[1]);
      if (/^https?:\/\//.test(url)) urls.add(url);
    } catch {
      /* skip malformed */
    }
  }
  return [...urls];
}

function decodeBingLinks(html: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+class="b_title[^"]*"[^>]*href="(https?:\/\/[^"]+)"/g)) urls.add(m[1]);
  for (const m of html.matchAll(/<h2><a[^>]+href="(https?:\/\/[^"]+)"/g)) urls.add(m[1]);
  return [...urls];
}

function decodeMojeekLinks(html: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+class="title"[^>]*href="(https?:\/\/[^"]+)"/g)) urls.add(m[1]);
  return [...urls];
}

// Search engines, tried in order until one returns links. Mojeek is an
// independent index that tolerates scraping; DuckDuckGo and Bing increasingly
// serve anomaly/consent pages (HTTP 202 / resultless HTML) to datacenter IPs.
const ENGINES: { name: string; url: (q: string) => string; decode: (html: string) => string[]; headers?: Record<string, string> }[] = [
  {
    name: 'duckduckgo',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    decode: decodeDdgLinks,
    headers: { 'User-Agent': MINIMAL_UA },
  },
  { name: 'mojeek', url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, decode: decodeMojeekLinks },
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`, decode: decodeBingLinks },
];

const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

export async function fetchText(url: string, timeoutMs: number, extraHeaders: Record<string, string> = {}): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(target);
      const res = await publicFetch(target, {
        headers: { ...PAGE_HEADERS, ...extraHeaders },
        redirect: 'manual',
        signal: ctrl.signal,
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        try {
          target = new URL(res.headers.get('location')!, target).toString();
        } catch {
          throw new Error('bad redirect');
        }
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/i.test(ct) && ct !== '') throw new Error(`non-HTML (${ct})`);
      return await readCappedText(res, MAX_PAGE_BYTES);
    }
    throw new Error('too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function searchLinks(term: string, disabled: string[] = []): Promise<string[]> {
  // Walk the engines until one yields results. An engine that throws, blocks
  // (anomaly page), or returns zero links is skipped, as is any turned off in
  // Settings (one that has started blocking this server, say).
  for (const engine of ENGINES.filter((e) => !disabled.includes(e.name))) {
    try {
      const html = await fetchText(engine.url(term), PAGE_TIMEOUT_MS, engine.headers ?? {});
      const links = engine.decode(html);
      if (links.length > 0) return links;
    } catch {
      /* try next engine */
    }
  }
  return [];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const websearch: EventSourceAdapter = {
  name: 'websearch',
  label: 'Web search (unofficial)',
  unofficial: true,

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    const terms =
      [...expandTopics(settings.eventTopics, loc.city, webQuery), ...settings.webSearchTerms];
    const usable = rotateQueries(
      (terms.length > 0
        ? terms
        : [`events in ${loc.city} this month`, `things to do in ${loc.city} this weekend`]
      ).filter((t) => t.trim()),
      loc.queryBudget ?? MAX_QUERIES_PER_AREA
    );
    if (usable.length === 0) {
      throw new MissingConfigError('Add search terms in Settings (or set a city) to scrape search engines for events.');
    }

    // Gather candidate result URLs across all queries, de-duped by host+path.
    const candidates: string[] = [];
    const seenUrls = new Set<string>();
    const searchErrors: string[] = [];
    for (const [i, term] of usable.entries()) {
      // Paced deliberately. Fired back to back across several areas the engines
      // start returning empty pages rather than errors, so the refresh looks
      // like it worked and quietly finds nothing.
      if (i > 0) await sleep(QUERY_SPACING_MS);
      const links = await searchLinks(term.trim(), settings.webSearchDisabledEngines ?? []);
      if (links.length === 0) searchErrors.push(`"${term}" returned no results`);
      for (const url of links.slice(0, RESULTS_PER_QUERY)) {
        const host = hostOf(url);
        if (!host || SKIP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
        const norm = url.split('#')[0];
        if (seenUrls.has(norm)) continue;
        seenUrls.add(norm);
        candidates.push(norm);
      }
    }

    if (candidates.length === 0) {
      throw new Error(
        searchErrors.length > 0
          ? `No usable results — ${searchErrors[0]}. Search engines sometimes rate-limit scraping; try again later.`
          : 'No usable result pages found.'
      );
    }

    const events: RawEvent[] = [];
    const seenEvents = new Set<string>();
    let pagesFetched = 0;
    let pageErrors = 0;

    for (const url of candidates.slice(0, MAX_PAGES_TOTAL)) {
      pagesFetched++;
      try {
        const html = await fetchText(url, PAGE_TIMEOUT_MS);
        for (const ev of extractEventsFromHtml(html, url)) {
          if (seenEvents.has(ev.sourceId)) continue;
          seenEvents.add(ev.sourceId);
          events.push(ev);
        }
      } catch {
        pageErrors++; // blocked / timed out / non-HTML — expected for many sites
      }
      await new Promise((r) => setTimeout(r, 250)); // gentle pacing
    }

    if (events.length === 0) {
      throw new Error(
        `Fetched ${pagesFetched} result page(s) (${pageErrors} blocked or empty) but found no structured event data. ` +
          'Try more specific search terms, e.g. a venue or "<city> festival schema events".'
      );
    }
    return events;
  },
};
