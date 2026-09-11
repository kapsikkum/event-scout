import { haversineKm } from '../dedupe.js';
import { fetchFb, parseEvent } from './facebook.js';
import { expandTopics, rotateQueries } from './topics.js';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';

/**
 * Events from the crawler, which is a separate program.
 *
 * It runs beside this one, keeps its own database and its own frontier, and is
 * asked rather than listened to: this adapter fetches what it has found when a
 * refresh comes round, and everything after that — validation, geocoding,
 * dedupe, archiving, the model passes — happens exactly as it does for any
 * other source. So a crawler that returns nonsense is a switch in Settings and
 * nothing worse, and it never holds a credential for this app or writes a row.
 *
 * What it should look for is handed over separately, by syncCrawler below, so
 * Settings stays the one place any of it is decided.
 */

const TIMEOUT_MS = 20000;
const SYNC_TIMEOUT_MS = 8000;

/** What the crawler sends. Its own shape, close to but not the same as ours. */
interface CrawledEvent {
  sourceId: string;
  title: string;
  description?: string;
  startTime: string;
  endTime?: string;
  venueName?: string;
  address?: string;
  lat?: number;
  lng?: number;
  url?: string;
  imageUrl?: string;
  priceText?: string;
  isOnline?: boolean;
  dateOnly?: boolean;
}

/** Where the crawler listens: Settings, then CRAWLER_URL, then nowhere. */
export function crawlerBase(settings: Settings): string {
  const url = (settings.crawlerUrl ?? '').trim() || process.env.CRAWLER_URL || '';
  return url.replace(/\/+$/, '');
}

export interface CrawlerConfig {
  /** Each area, with the bare terms to search for in it. */
  interests: { city: string; terms: string[] }[];
  /** Pages to read every few hours, whatever the searches find. */
  seeds: string[];
}

/**
 * What the crawler should look for, from Settings.
 *
 * The same topics and extra terms web search expands, in every area, so
 * switching a topic on changes what both go looking for. Before this only the
 * extra terms were passed — empty, in the usual case — and the crawler fell
 * back on a generic list of its own, ignoring every topic that had been chosen.
 *
 * Pure, so what the crawler is told can be tested without one.
 */
export function crawlerConfigFrom(settings: Settings): CrawlerConfig {
  const extra = (settings.webSearchTerms ?? []).map((t) => t.trim()).filter(Boolean);
  const interests: CrawlerConfig['interests'] = [];
  const seen = new Set<string>();
  for (const raw of [settings.city, ...(settings.eventAreas ?? []).map((a) => a.name)]) {
    const city = (raw ?? '').trim();
    if (!city || seen.has(city.toLowerCase())) continue;
    seen.add(city.toLowerCase());
    // The format ignores the place: the crawler appends whichever area it is
    // searching, so a term goes over bare.
    const topics = expandTopics(settings.eventTopics ?? [], city, (term) => term);
    interests.push({ city, terms: [...new Set([...topics, ...extra])] });
  }
  const seeds = [
    ...new Set((settings.crawlerUrls ?? []).map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/i.test(u))),
  ];
  return { interests, seeds };
}

/**
 * Tell the crawler what to look for.
 *
 * Called when settings are saved, at startup, and before every fetch, so a
 * change reaches it on its next cycle rather than at the next refresh, which
 * can be six hours away. With the source switched off it is sent nothing to
 * do, which puts it to rest — otherwise switching the source off would only
 * stop this app listening while the crawler carried on regardless.
 *
 * Never throws. A crawler that is down must not make saving settings fail.
 */
export async function syncCrawler(settings: Settings): Promise<{ ok: boolean; message: string }> {
  const base = crawlerBase(settings);
  if (!base) return { ok: false, message: 'no crawler address' };
  const off = settings.enabledSources?.crawler === false;
  const body: CrawlerConfig = off ? { interests: [], seeds: [] } : crawlerConfigFrom(settings);
  try {
    const res = await fetch(`${base}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, message: off ? 'told to rest' : 'told what to look for' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** Facebook event pages read per refresh, rotating through the rest. */
const FB_PER_REFRESH = 25;
const FB_DELAY_MS = 500;
/** A refresh asks once per area; an event read for the first is not read again for the next. */
const FB_REUSE_MS = 30 * 60 * 1000;
const fbRead = new Map<string, { at: number; event: RawEvent | null }>();

/**
 * Facebook events the crawl came across, read here.
 *
 * The crawler notes the links and nothing more: reading a Facebook event page
 * takes a parser for Facebook's embedded format, and this app already has one,
 * so the reading happens where the parser is. No cookie is needed for an event
 * page — the one set for the Facebook source is sent if there is one.
 */
async function facebookFromCrawler(base: string, loc: Location, settings: Settings): Promise<RawEvent[]> {
  let links: { id: string }[] = [];
  try {
    const res = await fetch(`${base}/social?kind=facebook-event`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    links = ((await res.json()) as { links?: { id: string }[] }).links ?? [];
  } catch {
    return [];
  }

  const out: RawEvent[] = [];
  for (const id of rotateQueries(links.map((l) => l.id).filter((id) => /^\d+$/.test(id)), FB_PER_REFRESH)) {
    let seen = fbRead.get(id);
    if (!seen || Date.now() - seen.at > FB_REUSE_MS) {
      let event: RawEvent | null = null;
      try {
        event = parseEvent(await fetchFb(`https://www.facebook.com/events/${id}`, (settings.fbCookie ?? '').trim()), id);
      } catch {
        // Private, deleted, or behind a login wall: expected, and not worth a failure.
      }
      seen = { at: Date.now(), event };
      fbRead.set(id, seen);
      await new Promise((r) => setTimeout(r, FB_DELAY_MS));
    }
    const ev = seen.event;
    if (!ev) continue;
    // Placed events are kept to the area, as the Facebook source does; unplaced
    // ones are kept, since they are usually the small local ones.
    if (ev.lat != null && ev.lng != null && haversineKm(loc.lat, loc.lng, ev.lat, ev.lng) > loc.radiusKm * 1.5) continue;
    out.push({ ...ev, sourceId: `crawl:fb:${id}` });
  }
  return out;
}

export const crawlerSource: EventSourceAdapter = {
  name: 'crawler',
  label: 'Web crawler',
  unofficial: true,

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    const base = crawlerBase(settings);
    if (!base) {
      throw new MissingConfigError(
        'No crawler address. Run the crawler container and set its URL in Settings.'
      );
    }
    // Kept current on every refresh as well as on save, in case the crawler
    // was down, or started over with an empty database, when settings changed.
    await syncCrawler(settings);

    const query = new URLSearchParams({
      lat: String(loc.lat),
      lng: String(loc.lng),
      radiusKm: String(loc.radiusKm),
    });

    let res: Response;
    try {
      res = await fetch(`${base}/events?${query}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = (err as Error).name === 'TimeoutError' ? 'no answer' : (err as Error).message;
      throw new Error(`Cannot reach the crawler at ${base}: ${reason}`);
    }
    if (!res.ok) throw new Error(`The crawler answered HTTP ${res.status}`);

    const body = (await res.json()) as { events?: CrawledEvent[] };
    const events = Array.isArray(body.events) ? body.events : [];

    const crawled = events
      .filter((e) => e && typeof e.title === 'string' && typeof e.startTime === 'string')
      .map((e): RawEvent => ({
        // Prefixed so a crawled listing can never collide with one scraped
        // directly, and so it is obvious in the database where a row came from.
        sourceId: `crawl:${e.sourceId}`.slice(0, 400),
        title: e.title,
        description: e.description,
        startTime: e.startTime,
        endTime: e.endTime,
        venueName: e.venueName,
        address: e.address,
        lat: e.lat,
        lng: e.lng,
        url: e.url,
        imageUrl: e.imageUrl,
        priceText: e.priceText,
        isOnline: e.isOnline,
        dateOnly: e.dateOnly === true,
      }));
    return [...crawled, ...(await facebookFromCrawler(base, loc, settings))];
  },
};
