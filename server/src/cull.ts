import { haversineKm } from './dedupe.js';

/**
 * Which events to keep out of sight on their own.
 *
 * Two rules, both switched from Settings: an event well outside every area
 * being searched, and an event in a category nobody asked for. Worked out each
 * time the list is read rather than stored, so changing an area or a category
 * puts back everything the old setting took away — nothing here is a decision
 * that has to be undone by hand, and nothing is ever deleted.
 *
 * Kept out of reach of both rules:
 *
 *   - a starred event, which somebody has already said they want;
 *   - one added by hand from a link, for the same reason;
 *   - one with no place at all. "Unknown location" is not "far away" — an
 *     Instagram post that never names its town is usually the small local
 *     thing this app exists to find;
 *   - for the category rule, one whose category was set by hand.
 *
 * Pure, so every one of those can be tested without a database.
 */

export interface Cullable {
  lat: number | null;
  lng: number | null;
  locality: string;
  /** The town it rounds to, '' when none. Anything that rounds to one of the areas is in it. */
  place: string;
  category: string;
  starred: boolean;
  unknownLocation: boolean;
  sources: { source: string }[];
  edited: string[];
}

export interface CullHub {
  name: string;
  lat: number | null;
  lng: number | null;
  radiusKm: number;
}

export interface CullRules {
  cullOutsideAreas?: boolean;
  excludedCategories?: string[];
}

/**
 * The same slack the ingest check gives: a venue just over the line of a
 * radius picked for searching is not what anyone means by "outside".
 */
const SLACK = 1.5;

/** Why this event is out of sight, or null when it is not. */
export function cullReason(
  ev: Cullable,
  hubs: CullHub[],
  rules: CullRules,
  positionsOf: (name: string) => { lat: number; lng: number }[] = () => []
): string | null {
  if (ev.starred) return null;
  if (ev.sources.some((s) => s.source === 'manual')) return null;

  const excluded = new Set((rules.excludedCategories ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  if (excluded.has(ev.category.trim().toLowerCase()) && !ev.edited.includes('category')) {
    return `Excluded category: ${ev.category}`;
  }

  if (!rules.cullOutsideAreas || ev.unknownLocation || ev.place) return null;
  // Where it is: its own coordinates, else every place its town's name was
  // found when it was last looked up. Nothing is looked up here — an event
  // that cannot be put on the map without a request is one that cannot be
  // judged, and is left alone. A town name that also exists inside an area
  // counts as inside: Kelso is a suburb of Bathurst as well as a Scottish
  // town, and hiding a local event on a namesake's account is the worse error.
  const points =
    ev.lat != null && ev.lng != null ? [{ lat: ev.lat, lng: ev.lng }] : ev.locality ? positionsOf(ev.locality) : [];
  if (points.length === 0) return null;
  const positioned = hubs.filter((h) => h.lat != null && h.lng != null);
  if (positioned.length === 0) return null;

  let nearest: { hub: CullHub; km: number } | null = null;
  for (const at of points) {
    for (const hub of positioned) {
      const km = haversineKm(at.lat, at.lng, hub.lat as number, hub.lng as number);
      if (km <= hub.radiusKm * SLACK) return null;
      if (!nearest || km < nearest.km) nearest = { hub, km };
    }
  }
  return `${Math.round(nearest!.km)} km from ${nearest!.hub.name}, the nearest area`;
}
