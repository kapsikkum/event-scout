import ical from 'node-ical';
import crypto from 'node:crypto';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';

/** How far ahead a feed is read. Council calendars publish years of bin nights. */
const HORIZON_MONTHS = 6;

/** How long a feed has to answer. A hung one used to hold up the whole refresh. */
const FEED_TIMEOUT_MS = 20_000;

/** webcal:// is https:// under another name, there for calendar apps' benefit. */
export function feedUrl(raw: string): string {
  return raw.trim().replace(/^webcals?:\/\//i, 'https://');
}

/**
 * A property as text. node-ical hands back `{ params, val }` rather than a
 * string when the property carries parameters — `SUMMARY;LANGUAGE=en:Fair` —
 * and the old String() of that was a listing titled "[object Object]".
 */
function text(value: unknown): string {
  if (value && typeof value === 'object' && 'val' in value) return String((value as { val: unknown }).val ?? '');
  return value == null ? '' : String(value);
}

export interface ParsedFeed {
  /** What the feed calls itself (X-WR-CALNAME), '' when it does not say. */
  calendarName: string;
  /** Every event in the file, whenever it is. */
  total: number;
  /** The ones the source would keep: from yesterday to six months out. */
  events: RawEvent[];
}

/**
 * What is in a calendar file.
 *
 * Pure, so the preview and the source cannot disagree about a feed: both read
 * it through here, and what the preview shows is exactly what adding the feed
 * would bring in.
 */
export function parseFeed(body: string, url: string, name: string, now = new Date()): ParsedFeed {
  if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error('that is not a calendar file');
  const data = ical.sync.parseICS(body);
  const horizon = new Date(now);
  horizon.setMonth(horizon.getMonth() + HORIZON_MONTHS);
  const from = new Date(now.getTime() - 24 * 3600 * 1000);
  // From the address as configured, not as fetched, so sourceIds stay put.
  const feedKey = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);

  let total = 0;
  const events: RawEvent[] = [];
  for (const item of Object.values(data)) {
    if (!item || item.type !== 'VEVENT') continue;
    const ev = item as ical.VEvent;
    if (!ev.start) continue;
    total++;
    const start = new Date(ev.start);
    // Kept until it is over, not until it has started. Judged on the start,
    // an exhibition that opened in June and runs to Christmas was dropped for
    // its whole run: all thirty events in Central NSW's feed were, and so was
    // a week-long car tour on the day it was passing through.
    const end = ev.end ? new Date(ev.end) : start;
    if (start > horizon || end < from) continue;
    const title = text(ev.summary) || 'Untitled event';
    const uid = ev.uid ?? crypto.createHash('sha1').update(`${url}|${title}|${start.toISOString()}`).digest('hex');
    const geo = (ev as unknown as { geo?: { lat?: number; lon?: number } }).geo;
    events.push({
      sourceId: `${feedKey}:${uid}`,
      title,
      description: text(ev.description),
      startTime: start.toISOString(),
      // node-ical already builds an all-day VALUE=DATE at local midnight,
      // and says so; the flag is what stops it being shown as "12:00 am".
      dateOnly: (ev as unknown as { datetype?: string }).datetype === 'date',
      endTime: ev.end ? new Date(ev.end).toISOString() : undefined,
      venueName: name,
      address: text(ev.location),
      lat: geo?.lat,
      lng: geo?.lon,
      url: typeof ev.url === 'string' ? ev.url : '',
      category: 'Community',
    });
  }
  const calendarName = text(body.match(/^X-WR-CALNAME:(.*)$/im)?.[1]).trim();
  return { calendarName, total, events };
}

/** Fetch a feed and read it. Throws with a reason a person can act on. */
export async function readFeed(url: string, name: string): Promise<ParsedFeed> {
  const res = await fetch(feedUrl(url), {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), url, name);
}

export const icalSource: EventSourceAdapter = {
  name: 'ical',
  label: 'Calendar feeds',

  async fetchEvents(_loc: Location, settings: Settings): Promise<RawEvent[]> {
    if (settings.icalFeeds.length === 0) {
      throw new MissingConfigError('Add iCal/ICS feed URLs in Settings (city calendars, parks departments, venues).');
    }
    const events: RawEvent[] = [];
    for (const feed of settings.icalFeeds) {
      events.push(...(await readFeed(feed.url, feed.name)).events);
    }
    return events;
  },
};
