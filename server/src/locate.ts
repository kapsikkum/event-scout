import { haversineKm } from './shared/geo.js';
import { localityOf, regionOf } from './regions.js';

/**
 * Working out where a listing is, without inventing an answer.
 *
 * The old order of business was: ask the geocoder for the venue and the
 * address, and if neither names one of the towns being searched, ask again
 * with a town's name stapled on. That last step is what put a Northern
 * Territory motocross round 3.4 km from Bathurst: "Darwin, Bathurst" is a
 * real result — Darwin Drive, Llanarth — and it was inside the area, so it
 * was believed. "Newcastle, Bathurst" is Newcastle Place, Kelso. A listing
 * from anywhere in the country could be dragged into the area this way, and
 * once it had local coordinates nothing downstream could tell.
 *
 * So: the town a listing names is asked about first, on its own, and whatever
 * comes back anchors everything else. A venue is only believed where it sits
 * near that anchor, and a town's name is only stapled on when the listing
 * names no town at all. A listing from a far town now gets that town's
 * position — which is honest, and lets the area rule hide it — rather than a
 * street in the area that happens to share a name.
 *
 * Pure: every function here takes what it needs and returns what it decided.
 */

export interface Stated {
  /** The region the listing names ('nsw'), or '' when it names none. */
  region: string;
  /** The town or suburb it names, '' when none. */
  locality: string;
}

export interface Hit {
  displayName: string;
  lat: number;
  lng: number;
  /** What the geocoder called it, "place:town". Absent in older cached answers. */
  kind?: string;
}

/** An area being searched: enough of it to measure a result against. */
export interface LocateArea {
  lat: number | null;
  lng: number | null;
  radiusKm: number;
}

/** What a listing says about where it is, before anything is looked up. */
export function statedOf(venueName: string, address: string): Stated {
  return {
    region: regionOf(address) || regionOf(venueName),
    locality: localityOf(address) || localityOf(venueName),
  };
}

/**
 * How far from the town it names a listing's own position may sit.
 *
 * A town's own pin is its centre, and a venue can be well outside the built-up
 * part — a speedway, a showground, a racetrack. Wide enough for those, far too
 * narrow to reach the next town of the same name.
 */
export const ANCHOR_REACH_KM = 50;

/**
 * The queries that find the town itself, best first. Empty when the listing
 * names no town.
 *
 * The region goes in first so the right one of the seven Newcastles comes
 * back, and the bare name follows because that is what the answer was filed
 * under before regions were asked for, and a cached answer costs nothing.
 */
export function anchorQueries(stated: Stated): string[] {
  if (!stated.locality) return [];
  return stated.region ? [`${stated.locality}, ${stated.region}`, stated.locality] : [stated.locality];
}

/**
 * What a town, suburb or city comes back as. A pub, a park or a street may
 * share a town's name — Darwin Drive, the Victoria Hotel — and cannot stand
 * in for one.
 */
const PLACE_KINDS = new Set([
  'city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood', 'locality',
  'municipality', 'county', 'district', 'region', 'state', 'province', 'island',
]);

/**
 * Whether a result is a populated place rather than a thing inside one.
 *
 * An answer cached before the kind was kept says nothing either way, and is
 * allowed: those were all looked up as towns.
 */
export function isPlace(hit: Hit): boolean {
  if (!hit.kind) return true;
  const [group, type] = hit.kind.split(':');
  return (group === 'place' || group === 'boundary') && PLACE_KINDS.has(type);
}

/**
 * A last try at the town, for a listing whose "town" is not one.
 *
 * Instagram and flyer text leaves things like "MXGP DARWIN AUSTRALIA" in the
 * venue field: no address, no state, and localityOf can only hand back the
 * whole shout. The geocoder reads it as Darwin, and a populated place is
 * exactly what this needs — so the answer is taken only when it is one.
 */
export function textAnchorQuery(venueName: string, address: string, stated: Stated): string {
  const text = (address || venueName).trim();
  if (!text || !stated.locality) return '';
  // Only when the town on offer is not a plausible town: several words, or
  // shouted. A real one has already been tried by anchorQueries.
  const words = stated.locality.trim().split(/\s+/);
  const shouted = stated.locality === stated.locality.toUpperCase();
  return words.length > 2 || shouted ? text.slice(0, 120) : '';
}

/**
 * The queries that place the listing precisely, best first.
 *
 * With a town known, nothing here needs an area's name: the town is what makes
 * the query specific. Only a listing that names no town at all falls back to
 * the areas, which is the one case where "169 College Road" needs them — and
 * where the answer is checked against the areas anyway.
 */
export function placeQueries(
  venueName: string, address: string, stated: Stated, areas: { name: string }[]
): string[] {
  const out: string[] = [];
  const push = (q: string): void => {
    const trimmed = q.trim().replace(/^,|,$/g, '').trim().slice(0, 200);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };

  if (stated.locality) {
    if (address) push(address);
    if (venueName) {
      push(`${venueName}, ${stated.locality}${stated.region ? `, ${stated.region}` : ''}`);
      // A venue whose own name carries its town — "Sydney Motorsport Park" —
      // answers better without the town repeated after it.
      push(venueName);
    }
    return out.slice(0, MAX_QUERIES);
  }

  // No town named: the areas are the only hint there is, and a hit is believed
  // only where it lands inside one of them.
  for (const area of areas) {
    if (address) push(`${address}, ${area.name}`);
    if (venueName) push(`${venueName}, ${area.name}`);
  }
  if (venueName.includes(',')) push(venueName.split(',')[0]);
  return out.slice(0, MAX_QUERIES);
}

/** Lookups one listing may cost, so a stubborn one cannot eat a whole refresh. */
export const MAX_QUERIES = 4;

/** Whether a result names the region the listing does. A result that names none is allowed. */
export function regionFits(hit: Hit, region: string): boolean {
  if (!region) return true;
  const found = regionOf(hit.displayName);
  return !found || found === region;
}

export function inAnyArea(lat: number, lng: number, areas: LocateArea[], slack: number): boolean {
  return areas.some(
    (a) => a.lat != null && a.lng != null && haversineKm(a.lat, a.lng, lat, lng) <= a.radiusKm * slack
  );
}

/**
 * The result to believe for a listing, or null.
 *
 * With an anchor — the town's own position — a result counts when it names the
 * right region and sits within reach of that town. Without one, only a result
 * inside one of the areas counts, because the query had an area's name in it
 * and a hit that landed outside is the geocoder reaching for anything.
 */
export function pickHit(
  hits: Hit[],
  opts: { region: string; anchor: Hit | null; areas: LocateArea[]; slack: number }
): Hit | null {
  for (const hit of hits) {
    if (!regionFits(hit, opts.region)) continue;
    if (opts.anchor) {
      if (haversineKm(opts.anchor.lat, opts.anchor.lng, hit.lat, hit.lng) <= ANCHOR_REACH_KM) return hit;
      continue;
    }
    if (inAnyArea(hit.lat, hit.lng, opts.areas, opts.slack)) return hit;
  }
  return null;
}

/**
 * Whether stored coordinates contradict the town the listing names.
 *
 * For the listings placed before any of this: a Darwin event pinned in
 * Bathurst still says Darwin, and the town is the more believable of the two.
 * Read at display time as well as by the geocoder, so those pins stop being
 * trusted without waiting for every row to be looked up again.
 */
export function coordsDisagree(
  coords: { lat: number; lng: number }, anchor: Hit | null
): boolean {
  if (!anchor) return false;
  return haversineKm(anchor.lat, anchor.lng, coords.lat, coords.lng) > ANCHOR_REACH_KM;
}
