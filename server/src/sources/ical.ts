import ical from 'node-ical';
import crypto from 'node:crypto';
import { assertPublicUrl, publicFetch, readCappedText } from '../nethost.js';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';

/** How far ahead a feed is read. Council calendars publish years of bin nights. */
const HORIZON_MONTHS = 6;

/** Occurrences kept per recurring event, so one badly-bounded RRULE cannot blow up a feed. */
const MAX_OCCURRENCES = 60;

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
  // Counted before parsing, since node-ical builds every entry before any of
  // them can be judged against the horizon.
  const entries = body.match(/^BEGIN:VEVENT/gim)?.length ?? 0;
  if (entries > MAX_FEED_EVENTS) throw new Error(`the feed has ${entries} events; more than ${MAX_FEED_EVENTS} is not read`);
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
    const end = ev.end ? new Date(ev.end) : start;
    const duration = end.getTime() - start.getTime();
    const title = text(ev.summary) || 'Untitled event';
    const uid = ev.uid ?? crypto.createHash('sha1').update(`${url}|${title}|${start.toISOString()}`).digest('hex');
    const geo = (ev as unknown as { geo?: { lat?: number; lon?: number } }).geo;
    const dateOnly = (ev as unknown as { datetype?: string }).datetype === 'date';
    const address = text(ev.location);
    const eventUrl = typeof ev.url === 'string' ? ev.url : '';
    const description = text(ev.description);

    const push = (occStart: Date, occEnd: Date, id: string): void => {
      // Kept until it is over, not until it has started. Judged on the start,
      // an exhibition that opened in June and runs to Christmas was dropped for
      // its whole run: all thirty events in Central NSW's feed were, and so was
      // a week-long car tour on the day it was passing through.
      if (occStart > horizon || occEnd < from) return;
      events.push({
        sourceId: `${feedKey}:${id}`,
        title,
        description,
        startTime: occStart.toISOString(),
        // node-ical already builds an all-day VALUE=DATE at local midnight,
        // and says so; the flag is what stops it being shown as "12:00 am".
        dateOnly,
        endTime: ev.end ? occEnd.toISOString() : undefined,
        venueName: name,
        address,
        lat: geo?.lat,
        lng: geo?.lon,
        url: eventUrl,
        category: 'Community',
      });
    };

    const rrule = (ev as unknown as { rrule?: { between: (a: Date, b: Date, inc?: boolean) => Date[] } }).rrule;
    if (!rrule) {
      push(start, end, uid);
      continue;
    }

    // A repeating event is judged occurrence by occurrence rather than once
    // off its first DTSTART, so a weekly market six months from now is not
    // silently dropped because the series itself began last year.
    const exdate = (ev as unknown as { exdate?: Record<string, Date> }).exdate ?? {};
    const excluded = new Set(Object.values(exdate).map((d) => new Date(d).toISOString()));
    const overrides = (ev as unknown as { recurrences?: Record<string, ical.VEvent> }).recurrences ?? {};
    const occurrences = rrule.between(from, horizon, true).slice(0, MAX_OCCURRENCES);
    for (const occ of occurrences) {
      if (excluded.has(occ.toISOString())) continue;
      const override = Object.entries(overrides).find(([key]) => new Date(key).toISOString() === occ.toISOString())?.[1];
      if (override && override.start) {
        const oStart = new Date(override.start);
        const oEnd = override.end ? new Date(override.end) : new Date(oStart.getTime() + duration);
        push(oStart, oEnd, `${uid}:${oStart.toISOString()}`);
      } else {
        push(occ, new Date(occ.getTime() + duration), `${uid}:${occ.toISOString()}`);
      }
    }
  }
  const calendarName = text(body.match(/^X-WR-CALNAME:(.*)$/im)?.[1]).trim();
  return { calendarName, total, events };
}

const MAX_REDIRECTS = 5;
/** A feed with more entries than this is an archive, not a calendar. */
const MAX_FEED_EVENTS = 20_000;
/** A calendar feed bigger than this is not one worth reading in full. */
const MAX_FEED_BYTES = 10 * 1024 * 1024;

/** Fetch a feed and read it. Throws with a reason a person can act on. */
export async function readFeed(url: string, name: string): Promise<ParsedFeed> {
  let target = feedUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(target);
    const res = await publicFetch(target, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
      redirect: 'manual',
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
    return parseFeed(await readCappedText(res, MAX_FEED_BYTES), url, name);
  }
  throw new Error('too many redirects');
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
