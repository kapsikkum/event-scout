import type { MergedEvent } from '../events.js';
import type { NotifyFilters } from '../sources/types.js';

/** What a filter needs to know about an event. */
export type Filterable = Pick<
  MergedEvent,
  'title' | 'description' | 'venueName' | 'category' | 'photoScore' | 'place' | 'unknownLocation' | 'starred'
>;

/** "Penrith NSW", "Penrith, NSW" and "penrith" are one town. */
const town = (name: string): string =>
  name.split(',')[0].trim().replace(/\s+[A-Z]{2,3}$/, '').trim().toLowerCase();

/**
 * Whether a target lets this event through.
 *
 * Every rule narrows and an empty one lets everything past, so a new target
 * with nothing filled in hears about everything. `unknown` in the places is
 * for events with no place at all, which no town name would ever match.
 */
export function matchesFilters(ev: Filterable, f: NotifyFilters, opts: { ignoreStarredOnly?: boolean } = {}): boolean {
  if (f.starredOnly && !opts.ignoreStarredOnly && !ev.starred) return false;
  if (f.places.length) {
    const here = ev.unknownLocation ? 'unknown' : town(ev.place);
    if (!f.places.some((p) => (p.toLowerCase() === 'unknown' ? 'unknown' : town(p)) === here)) return false;
  }
  const category = ev.category.toLowerCase();
  if (f.categories.length && !f.categories.some((c) => c.toLowerCase() === category)) return false;
  if (f.excludeCategories.some((c) => c.toLowerCase() === category)) return false;
  if (f.minPhotoScore > 0 && ev.photoScore < f.minPhotoScore) return false;
  const text = `${ev.title}\n${ev.description}\n${ev.venueName}`.toLowerCase();
  if (f.keywords.length && !f.keywords.some((k) => text.includes(k.toLowerCase()))) return false;
  if (f.excludeKeywords.some((k) => text.includes(k.toLowerCase()))) return false;
  return true;
}
