// We bypass facebook-event-scraper's HTTP layer (it sends incomplete headers and
// gets a 400 "Error" stub back from Facebook) and instead fetch the HTML ourselves
// with a full browser fingerprint, then reuse the library's battle-tested HTML
// parser on the result.
// @ts-ignore - internal subpath, typed via the package's own .d.ts
import * as fbParser from 'facebook-event-scraper/dist/utils/htmlParser.js';
import { haversineKm } from '../dedupe.js';
import { EventSourceAdapter, Location, RawEvent, Settings } from './types.js';
import { expandTopics, fbQuery, rotateQueries } from './topics.js';
import { BROWSER_HEADERS } from '../useragent.js';

interface FbBasic {
  id: string;
  name: string;
  startTimestamp: number;
  isOnline: boolean;
  isCanceled: boolean;
  url: string;
  photo: { imageUri?: string } | null;
}
interface FbLocation {
  name: string;
  address: string;
  city: { name: string } | null;
  coordinates: { latitude: number; longitude: number } | null;
}
const parser = fbParser as {
  getBasicData(html: string): FbBasic;
  getLocation(html: string): FbLocation | null;
  getDescription(html: string): string;
  getCategories(html: string): { label: string }[];
  getEndTimestampAndTimezone(html: string, start: number): { endTimestamp: number | null };
};

// Facebook returns a 400 "Error" stub for requests that lack a full browser
// fingerprint. sec-fetch-site:none (a top-level navigation) is essential.
const FULL_HEADERS: Record<string, string> = { ...BROWSER_HEADERS };

const MAX_EVENTS_PER_REFRESH = 40;
const DETAIL_DELAY_MS = 500;

class LoginWallError extends Error {}

async function fetchFb(url: string, cookie: string): Promise<string> {
  const headers: Record<string, string> = { ...FULL_HEADERS };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, redirect: 'follow' });
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (/You must log in to continue|Log in to Facebook|name="checkpoint"|temporarily blocked|confirm your identity/i.test(html.slice(0, 8000))) {
    throw new LoginWallError('Facebook served a login/checkpoint wall');
  }
  return html;
}

function extractEventIds(html: string): string[] {
  const ids = new Set<string>();
  for (const re of [
    /\/events\/(\d{8,})/g,
    /"__typename":"Event","id":"(\d{8,})"/g,
    /"id":"(\d{8,})","__typename":"Event"/g,
  ]) {
    for (const m of html.matchAll(re)) ids.add(m[1]);
  }
  return [...ids];
}

function parseEvent(html: string, id: string): RawEvent | null {
  const basic = parser.getBasicData(html);
  if (!basic?.startTimestamp || basic.isCanceled) return null;
  const loc = basic.isOnline ? null : parser.getLocation(html);
  const coords = loc?.coordinates ?? null;
  let endTime: string | undefined;
  try {
    const end = parser.getEndTimestampAndTimezone(html, basic.startTimestamp).endTimestamp;
    if (end) endTime = new Date(end * 1000).toISOString();
  } catch {
    /* end time is optional */
  }
  let category = 'Facebook';
  try {
    category = parser.getCategories(html)?.[0]?.label ?? 'Facebook';
  } catch {
    /* categories optional */
  }
  let description = '';
  try {
    description = parser.getDescription(html) ?? '';
  } catch {
    /* description optional */
  }
  return {
    sourceId: basic.id ?? id,
    title: basic.name ?? 'Untitled event',
    description,
    startTime: new Date(basic.startTimestamp * 1000).toISOString(),
    endTime,
    venueName: loc?.name ?? '',
    address: loc?.address ?? loc?.city?.name ?? '',
    lat: coords?.latitude,
    lng: coords?.longitude,
    url: basic.url ?? `https://www.facebook.com/events/${id}`,
    imageUrl: basic.photo?.imageUri ?? undefined,
    category,
    isOnline: basic.isOnline,
  };
}

export const facebook: EventSourceAdapter = {
  name: 'facebook',
  label: 'Facebook (unofficial)',
  unofficial: true,

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    const cookie = settings.fbCookie.trim();

    // Build discovery URLs. Search terms default to "<city> events" — bare city
    // names return nothing from Facebook's search.
    const chosen = [...expandTopics(settings.eventTopics, loc.city, fbQuery), ...settings.fbSearchTerms];
    // Each search is a full page fetch through Facebook, so the budget is
    // tighter here than for the search engines.
    const terms = rotateQueries(
      chosen.length > 0
        ? chosen
        : loc.city
          ? [`${loc.city} events`]
          : [],
      8
    );
    const discovery: { kind: string; url: string }[] = [];
    for (const term of terms) {
      if (term.trim()) discovery.push({ kind: `search "${term}"`, url: `https://www.facebook.com/events/search/?q=${encodeURIComponent(term.trim())}` });
    }
    for (const page of settings.fbPages) {
      const slug = page.trim().replace(/^https?:\/\/(www\.)?facebook\.com\//i, '').replace(/\/+$/, '');
      if (slug) discovery.push({ kind: `page "${slug}"`, url: `https://www.facebook.com/${slug}/upcoming_hosted_events` });
    }

    if (discovery.length === 0) {
      throw new Error('Set a location, or add Facebook search terms / Pages in Settings.');
    }

    const ids = new Set<string>();
    const errors: string[] = [];
    let loginWalls = 0;
    for (const d of discovery) {
      try {
        const html = await fetchFb(d.url, cookie);
        for (const id of extractEventIds(html)) ids.add(id);
      } catch (err) {
        if (err instanceof LoginWallError) loginWalls++;
        errors.push(`${d.kind}: ${(err as Error).message}`);
      }
    }

    if (ids.size === 0) {
      if (loginWalls > 0 || !cookie) {
        throw new Error(
          (cookie ? 'Facebook is showing a login/checkpoint wall — the cookie may be expired or flagged. ' : 'Facebook needs a logged-in cookie to show events. ') +
            'Re-copy a fresh c_user + xs cookie in Settings.'
        );
      }
      throw new Error(
        errors.length > 0
          ? `Found no events. ${errors[0]}. Facebook search is also inconsistent — try a more specific term or add Pages.`
          : 'Found no events — Facebook search returned nothing. Try a more specific term or add Pages.'
      );
    }

    const events: RawEvent[] = [];
    let detailWalls = 0;
    for (const id of [...ids].slice(0, MAX_EVENTS_PER_REFRESH)) {
      try {
        const html = await fetchFb(`https://www.facebook.com/events/${id}`, cookie);
        const ev = parseEvent(html, id);
        if (!ev) continue;
        // Search can surface far-away events; keep those without coords (often
        // small community events) but drop clearly distant ones.
        if (ev.lat != null && ev.lng != null && haversineKm(loc.lat, loc.lng, ev.lat, ev.lng) > loc.radiusKm * 1.5) {
          continue;
        }
        events.push(ev);
      } catch (err) {
        if (err instanceof LoginWallError) detailWalls++;
        // Individual failures (private/expired/blocked) are expected — skip.
      }
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    if (events.length === 0 && detailWalls > 0) {
      throw new Error('Facebook blocked the event detail pages (login/checkpoint wall). Re-copy a fresh cookie in Settings.');
    }
    return events;
  },
};
