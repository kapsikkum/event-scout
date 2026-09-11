import { config } from './config.js';
import { assertPublicUrl } from './fetch.js';
import * as store from './store.js';
import { eventLikeness, isSkippedHost, normalizeUrl } from './urls.js';

/**
 * Where a crawl starts.
 *
 * Search engines, because there is no other way to find a town's venues from a
 * cold start. They are the seed and nothing more: once a site is in the
 * frontier its own links are what get followed, which is the difference between
 * this and event-scout's websearch pass — that one goes back to the search
 * engine for everything, every time.
 *
 * Three engines because any one of them will rate-limit or change its markup,
 * and a seed list is not worth a dependency on a single source.
 */

/** The area event-scout is currently interested in. */
export interface Interest {
  city: string;
  lat: number | null;
  lng: number | null;
  radiusKm: number;
  terms: string[];
}

const DEFAULT_TERMS = [
  'events', 'what\'s on', 'festival', 'markets', 'live music',
  'car show', 'agricultural show', 'motorsport',
];

/** DuckDuckGo flags a full browser fingerprint as a bot; a bare one gets results. */
const MINIMAL_UA = 'Mozilla/5.0';

function queriesFor(interest: Interest): string[] {
  const terms = interest.terms.length ? interest.terms : DEFAULT_TERMS;
  const where = interest.city.trim();
  if (!where) return [];
  return terms.slice(0, 10).map((t) => `${t} ${where}`);
}

async function search(url: string): Promise<string> {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': MINIMAL_UA, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function ddgLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
    try {
      out.push(decodeURIComponent(m[1]));
    } catch {
      /* malformed */
    }
  }
  return out;
}

function bingLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h2><a[^>]+href="(https?:\/\/[^"]+)"/g)) out.push(m[1]);
  return out;
}

function mojeekLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a[^>]+class="title"[^>]*href="(https?:\/\/[^"]+)"/g)) out.push(m[1]);
  return out;
}

const ENGINES: { name: string; url: (q: string) => string; links: (html: string) => string[] }[] = [
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, links: ddgLinks },
  { name: 'mojeek', url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, links: mojeekLinks },
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, links: bingLinks },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Put search results into the frontier at depth 0.
 *
 * Seeds go in even when they score badly: a result for "events Bathurst" is a
 * site worth knowing about whatever its URL looks like, and the scoring is
 * there to order a site's own links once we are inside it.
 */
export async function seedFrom(interests: Interest[], log: (line: string) => void): Promise<number> {
  let added = 0;
  for (const interest of interests) {
    for (const query of queriesFor(interest)) {
      // One engine per query, rotating, so no single engine sees the lot.
      const engine = ENGINES[Math.floor(Math.random() * ENGINES.length)];
      try {
        const html = await search(engine.url(query));
        for (const raw of engine.links(html).slice(0, 10)) {
          const url = normalizeUrl(raw);
          if (!url || isSkippedHost(url)) continue;
          if (store.offer(url, 0, eventLikeness(url) + 5)) added++;
        }
      } catch (err) {
        log(`  seed "${query}" via ${engine.name}: ${(err as Error).message}`);
      }
      await sleep(1200);
    }
  }
  return added;
}
