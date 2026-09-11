import { MergedEvent, Settings, haversineKm } from './api';

export type DateChip = 'all' | 'today' | 'weekend' | 'week' | 'month';
export type SortKey = 'date' | 'photo' | 'distance' | 'place';

/**
 * The two location choices that are not the name of a town.
 *
 * Given a colon so neither can collide with a real place: the towns come from
 * the user's settings and from their own event data, and "Nearby" would be
 * a perfectly good name for a village somewhere.
 */
export const NEARBY = 'nearby:any';
export const ELSEWHERE = 'nearby:none';

export interface Filters {
  dateChip: DateChip;
  category: string;
  source: string;
  /**
   * A town name, NEARBY for anywhere the user searches, ELSEWHERE for
   * everything beyond them, or '' for no location filter at all.
   */
  place: string;
  search: string;
  hideOnline: boolean;
  showHidden: boolean;
  starredOnly: boolean;
  /** Only events first found in the last RECENT_DAYS days. */
  recentOnly: boolean;
  sort: SortKey;
}

/**
 * How far back "recently found" reaches. A week, because the refresh is hourly
 * and the list is looked at every few days: anything shorter and a find made
 * on Monday is gone before Thursday's look.
 */
export const RECENT_DAYS = 7;

/** First found within RECENT_DAYS. An event found before tracking began is not. */
export function isRecent(ev: MergedEvent, now = Date.now()): boolean {
  if (!ev.firstSeenAt) return false;
  return now - new Date(ev.firstSeenAt).getTime() < RECENT_DAYS * 86400000;
}

export const DEFAULT_FILTERS: Filters = {
  dateChip: 'all',
  category: '',
  source: '',
  place: '',
  search: '',
  hideOnline: true,
  showHidden: false,
  starredOnly: false,
  recentOnly: false,
  sort: 'date',
};

function dateWindow(chip: DateChip): [Date, Date] | null {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (chip) {
    case 'today':
      return [startOfDay, new Date(startOfDay.getTime() + 86400000)];
    case 'weekend': {
      // Upcoming Sat–Sun (if today is the weekend, the current one).
      const dow = now.getDay();
      const daysToSat = dow === 0 ? -1 : 6 - dow;
      const sat = new Date(startOfDay.getTime() + daysToSat * 86400000);
      return [dow === 0 || dow === 6 ? startOfDay : sat, new Date(sat.getTime() + 2 * 86400000)];
    }
    case 'week':
      return [startOfDay, new Date(startOfDay.getTime() + 7 * 86400000)];
    case 'month':
      return [startOfDay, new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())];
    default:
      return null;
  }
}

export function applyFilters(events: MergedEvent[], f: Filters, settings: Settings | null): MergedEvent[] {
  const window = dateWindow(f.dateChip);
  const q = f.search.trim().toLowerCase();
  let out = events.filter((ev) => {
    if (!f.showHidden && ev.hidden) return false;
    if (f.starredOnly && !ev.starred) return false;
    if (f.recentOnly && !isRecent(ev)) return false;
    if (f.hideOnline && ev.isOnline) return false;
    if (f.category && ev.category !== f.category) return false;
    if (f.source && !ev.sources.some((s) => s.source === f.source)) return false;
    if (f.place === NEARBY && !ev.place) return false;
    else if (f.place === ELSEWHERE && ev.place) return false;
    else if (f.place && f.place !== NEARBY && f.place !== ELSEWHERE && ev.place !== f.place) return false;
    if (window) {
      const t = new Date(ev.startTime);
      if (t < window[0] || t >= window[1]) return false;
    }
    if (q && !`${ev.title} ${ev.venueName} ${ev.description}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const dist = (ev: MergedEvent): number =>
    settings?.lat != null && settings.lng != null && ev.lat != null && ev.lng != null
      ? haversineKm(settings.lat, settings.lng, ev.lat, ev.lng)
      : Number.POSITIVE_INFINITY;

  if (f.sort === 'photo') out = [...out].sort((a, b) => b.photoScore - a.photoScore || a.startTime.localeCompare(b.startTime));
  else if (f.sort === 'distance') out = [...out].sort((a, b) => dist(a) - dist(b));
  else if (f.sort === 'place') {
    // Everything at one venue lands together, in date order within it, so a
    // trip out to Mount Panorama can be planned as a trip rather than as
    // three unrelated rows scattered down the list. Places with no name go
    // last: they are the ones there is nothing to plan around.
    out = [...out].sort((a, b) => {
      const pa = placeLabel(a);
      const pb = placeLabel(b);
      if (!pa !== !pb) return pa ? -1 : 1;
      return pa.localeCompare(pb, undefined, { sensitivity: 'base' }) || a.startTime.localeCompare(b.startTime);
    });
  }
  return out;
}

/** One card on the Events page: an event, and every date of its series shown. */
export interface Card {
  ev: MergedEvent;
  /** The dates of this series that survived the filters, `ev` first. */
  dates: MergedEvent[];
}

/**
 * Fold the dates of a repeating event into one card.
 *
 * A class that runs all term was twenty-seven identical cards, one per date,
 * burying everything around it. After the filters rather than before, so the
 * card is for the next date that matches them — "This weekend" shows this
 * weekend's session. The first date in the sorted list is the one kept, which
 * leaves the sort in charge of where the card goes.
 */
export function foldSeries(list: MergedEvent[]): Card[] {
  const out: Card[] = [];
  const bySeries = new Map<string, Card>();
  for (const ev of list) {
    const card = ev.series ? bySeries.get(ev.series) : undefined;
    if (card) {
      card.dates.push(ev);
      continue;
    }
    const fresh: Card = { ev, dates: [ev] };
    if (ev.series) bySeries.set(ev.series, fresh);
    out.push(fresh);
  }
  return out;
}

/**
 * The heading an event sorts and groups under.
 *
 * The venue comes first because that is what a scouting trip is planned
 * around — every Mount Panorama event under one heading is the point of the
 * sort. But plenty of sources put a street address in the venue field, and a
 * heading per street number is the thing this sort exists to prevent, so a
 * venue that opens with a number is read as an address and gives up its
 * locality instead. "Mount Panorama Circuit" survives; "105 William Street,
 * Bathurst" becomes Bathurst.
 *
 * The locality itself is worked out server-side, where the postal conventions
 * of each country live in one table rather than two.
 */
export function placeLabel(ev: MergedEvent): string {
  const venue = (ev.venueName || '').trim();
  const startsWithNumber = /^\d/.test(venue.split(',')[0].trim());
  if (venue && !startsWithNumber) return venue;
  return (ev.locality || venue || '').trim();
}

export function categoriesOf(events: MergedEvent[]): string[] {
  return [...new Set(events.map((e) => e.category).filter(Boolean))].sort();
}

/**
 * The towns to offer in the location filter, busiest first, plus how many
 * events fall outside all of them.
 *
 * Busiest first rather than alphabetical: the list is read to find where the
 * events are, and the towns with three listings between them are not the
 * answer to that question.
 */
export function placesOf(events: MergedEvent[]): { places: { name: string; count: number }[]; elsewhere: number } {
  const counts = new Map<string, number>();
  let elsewhere = 0;
  for (const ev of events) {
    if (!ev.place) elsewhere++;
    else counts.set(ev.place, (counts.get(ev.place) ?? 0) + 1);
  }
  const places = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { places, elsewhere };
}
