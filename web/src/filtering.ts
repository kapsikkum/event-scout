import { MergedEvent, Settings, haversineKm } from './api';

export type DateChip = 'all' | 'today' | 'weekend' | 'week' | 'month';
export type SortKey = 'date' | 'photo' | 'distance' | 'place';

export interface Filters {
  dateChip: DateChip;
  category: string;
  source: string;
  search: string;
  hideOnline: boolean;
  showHidden: boolean;
  starredOnly: boolean;
  sort: SortKey;
}

export const DEFAULT_FILTERS: Filters = {
  dateChip: 'all',
  category: '',
  source: '',
  search: '',
  hideOnline: true,
  showHidden: false,
  starredOnly: false,
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
    if (f.hideOnline && ev.isOnline) return false;
    if (f.category && ev.category !== f.category) return false;
    if (f.source && !ev.sources.some((s) => s.source === f.source)) return false;
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
