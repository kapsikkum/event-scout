import { config } from './config.js';
import { assertPublicUrl, publicFetch, readCapped } from './fetch.js';
import { Interest, queriesFor } from './queries.js';
import * as store from './store.js';
import { eventLikeness, isSkippedHost, normalizeUrl } from './urls.js';
import { socialKind } from './extract/social.js';

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

/** DuckDuckGo flags a full browser fingerprint as a bot; a bare one gets results. */
const MINIMAL_UA = 'Mozilla/5.0';

async function search(url: string): Promise<string> {
  // Redirects walked by hand so each hop is checked, as in fetchPage.
  let target = url;
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublicUrl(target);
    const res = await publicFetch(target, {
      headers: { 'User-Agent': MINIMAL_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location) {
      await res.body?.cancel().catch(() => undefined);
      target = new URL(location, target).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await readCapped(res, config.maxBytes);
    if (!buf) throw new Error('too large');
    return buf.toString('utf8');
  }
  throw new Error('too many redirects');
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
  { name: 'mojeek', url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, links: mojeekLinks },
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, links: ddgLinks },
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, links: bingLinks },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Put search results into the frontier at depth 0.
 *
 * Seeds go in even when they score badly: a result for "markets Bathurst" is a
 * site worth knowing about whatever its URL looks like, and the scoring is
 * there to order a site's own links once we are inside it.
 */
export async function seedFrom(interests: Interest[], log: (line: string) => void): Promise<number> {
  let added = 0;
  for (const interest of interests) {
    for (const query of queriesFor(interest, undefined, undefined, config.social)) {
      // Sequential fallback across engines (Mojeek -> DuckDuckGo -> Bing).
      let rawLinks: string[] = [];
      const errors: string[] = [];
      for (const engine of ENGINES) {
        try {
          const html = await search(engine.url(query));
          const found = engine.links(html);
          if (found.length > 0) {
            rawLinks = found;
            break;
          }
        } catch (err) {
          errors.push(`${engine.name}: ${(err as Error).message}`);
        }
      }
      if (rawLinks.length === 0 && errors.length > 0) {
        log(`  seed "${query}" failed across engines (${errors.join(', ')})`);
      }
      for (const raw of rawLinks.slice(0, 10)) {
        const url = normalizeUrl(raw);
        if (!url) continue;
        // A search for "car show Bathurst" turns up the club's Instagram
        // post as often as any website. See extract/social.ts.
        const social = config.social ? socialKind(url) : null;
        if (social) {
          if (store.offerSocial(social, `search: ${query}`)) added++;
          continue;
        }
        if (isSkippedHost(url)) continue;
        if (store.offer(url, 0, eventLikeness(url) + 5)) added++;
      }
      await sleep(1200);
    }
  }
  return added;
}
