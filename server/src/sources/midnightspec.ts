import { extractEventsFromHtml } from './jsonld.js';
import { EventSourceAdapter, Location, RawEvent, Settings } from './types.js';
import { localitiesFrom } from '../venues.js';
import { BROWSER_HEADERS } from '../useragent.js';

/**
 * MIDNIGHT_SPEC — Australian car meets, track days and Cars & Coffee.
 *
 * The site aggregates public organiser posts into one national calendar, and
 * publishes each state's whole list as a schema.org ItemList in the page's
 * JSON-LD. Six requests therefore cover the entire feed, with no browser and no
 * pagination: the front page renders only its first twenty rows and fetches the
 * rest from Supabase in the client, which is exactly the path worth avoiding.
 *
 * Unlike the Facebook source this needs no apology. robots.txt allows every
 * crawler by name, including the AI ones, and the site ships /llms.txt,
 * /sitemap.md and an Atom feed — it is built to be read. Every event keeps its
 * /event/<id> URL so the cards link back to the listing.
 */

const BASE = 'https://meets.midnightspec.com';

/** Every state the site covers. Its own sitemap lists exactly these. */
export const MIDNIGHTSPEC_STATES = ['nsw', 'vic', 'qld', 'wa', 'sa', 'nt'];

const PAGE_TIMEOUT_MS = 15000;
const PAGE_SPACING_MS = 1000;

/**
 * How long a fetched state page stays good for.
 *
 * `refreshAll` runs every adapter once per configured area, so without this a
 * three-area install would pull the same six pages eighteen times in a minute.
 * The feed is rebuilt daily; five minutes is well inside that and comfortably
 * longer than a refresh takes.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; events: RawEvent[] }>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchState(state: string): Promise<RawEvent[]> {
  const hit = cache.get(state);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.events;

  const url = `${BASE}/au/${state}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const events = extractEventsFromHtml(await res.text(), url);
    cache.set(state, { at: Date.now(), events });
    return events;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a listing is anywhere near the area being searched.
 *
 * This is a national feed and none of its listings carry coordinates, so
 * `validateLocation` — which can only judge an event that already knows where
 * it is — lets all three hundred and forty-odd through. On a Bathurst-sized
 * radius that means months of Perth and Darwin rows crowding out the sixty
 * venues a refresh can afford to geocode, so the filtering has to happen on the
 * names instead.
 *
 * The site normalises `addressLocality` to the nearest city rather than the
 * suburb — the Eastern Creek listings all say Sydney — which is what makes
 * matching on words alone work as well as it does.
 */
export function nearArea(ev: RawEvent, localities: Set<string>): boolean {
  if (localities.size === 0) return true;
  const text = `${ev.venueName ?? ''} ${ev.address ?? ''}`.toLowerCase();
  for (const word of text.replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
    if (word.length > 2 && localities.has(word)) return true;
  }
  return false;
}

export const midnightspec: EventSourceAdapter = {
  name: 'midnightspec',
  label: 'MIDNIGHT_SPEC car meets (unofficial)',
  unofficial: true,

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    const wanted = (settings.midnightspecStates ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter((s) => MIDNIGHTSPEC_STATES.includes(s));
    const states = wanted.length > 0 ? wanted : MIDNIGHTSPEC_STATES;

    // Drawn from the area's own name rather than a baked-in list, so the filter
    // follows whatever the user actually configured.
    const localities = localitiesFrom([loc.city].filter(Boolean), []);

    const events: RawEvent[] = [];
    const seen = new Set<string>();
    const failures: string[] = [];

    for (const [i, state] of states.entries()) {
      try {
        // Only a page we actually go and get needs the pacing; a cached one is
        // free, which is what makes the per-area repetition cheap.
        if (i > 0 && !cache.has(state)) await sleep(PAGE_SPACING_MS);
        for (const ev of await fetchState(state)) {
          if (seen.has(ev.sourceId)) continue;
          if (!nearArea(ev, localities)) continue;
          seen.add(ev.sourceId);
          events.push(ev);
        }
      } catch (err) {
        failures.push(`${state.toUpperCase()}: ${(err as Error).message}`);
      }
    }

    if (failures.length === states.length) {
      throw new Error(`Every state page failed — ${failures[0]}`);
    }
    return events;
  },
};
