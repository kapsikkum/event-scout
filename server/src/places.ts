/**
 * Rounding an event to the nearest town the user actually scouts.
 *
 * The event list mixes a car meet twenty minutes up the road with a kart club
 * day in Mount Gambier, and read straight down it there is no quick way to
 * tell one from the other. What is wanted is the coarse question — which town
 * is this near — answered for every event, so the list can be narrowed to a
 * town and everything out of reach falls into one bucket that can be ignored.
 *
 * "Which town" is deliberately not a table of cities. The towns are the ones
 * already named in the user's own settings: the home city and each search
 * area. Somebody scouting out of Halifax gets Halifax and Dartmouth from the
 * same code that gives this user Bathurst, Penrith and Orange. Anywhere the
 * user never asked about is elsewhere, which is exactly what it is.
 */

import { haversineKm } from './dedupe.js';
import { stripRegionAndPostcode } from './regions.js';

/** The place an event lands at when it is near none of the user's towns. */
export const ELSEWHERE = '';

/** A town that events round to. */
export interface Hub {
  name: string;
  lat: number | null;
  lng: number | null;
  /** How far from the centre still counts as this town. */
  radiusKm: number;
}

/** As much of an event as placing it needs. */
export interface Placeable {
  locality: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

/**
 * How many events at one locality make it worth an entry of its own.
 *
 * Below this a place is a stray listing and belongs in elsewhere with the
 * rest. Above it, it is somewhere the user is evidently being offered events
 * whether they asked for it or not — and a filter that cannot name it is
 * hiding fifty listings behind one word.
 */
const OWN_BUCKET_MIN = 5;

/**
 * How far apart the positioned listings at one locality may sit and still be
 * taken for one suburb.
 *
 * A suburb is a small thing. "Sydney" written in an address field is not, and
 * telling the two apart is what stops a city being filed under a town. The
 * geocoder only accepts a result inside a search area, so an address that says
 * no more than "Sydney, NSW" is stored with a position in the middle of
 * whichever area was being searched: fifty listings from Hornsby to Moorebank,
 * every one of them pinned near Penrith. What gives those positions away is
 * that they scatter over twenty kilometres, where the listings at a real
 * suburb sit within two.
 */
const SUBURB_SPREAD_KM = 15;

/**
 * How far from an area's centre a locality may sit and still be filed under it.
 *
 * An area's radius is how far to search, not how big the town is: Bathurst's
 * reaches Portland, fifty minutes up the road and a town with a name of its
 * own. Llanarth, Kelso and Perthville sit inside a dozen kilometres and are
 * what anyone there means by Bathurst; Newbridge at twenty-seven and Portland
 * at thirty-eight are not. Past this a locality keeps its own name, and the
 * area it lies in is kept alongside for anything that asks by area.
 */
const TOWN_REACH_KM = 12;

/** Where an event is, as a name to show and the searched area it lies in. */
export interface Placed {
  /** The town it rounds to, or its own town when that is further out. '' for elsewhere. */
  place: string;
  /** The searched area it is inside, '' when none. Equal to `place` for a suburb. */
  area: string;
}

const NOWHERE: Placed = { place: ELSEWHERE, area: ELSEWHERE };
const inArea = (name: string): Placed => ({ place: name, area: name });

/** Lowercase, unaccented, punctuation-free words: the comparable form of a name. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

const key = (text: string): string => words(text).join(' ');

/** Whether `needle` appears in `haystack` as a whole run of words. */
function containsWords(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

/**
 * The name to show for a configured area.
 *
 * Areas are written the way they are typed into a search box — "Penrith NSW",
 * "Halifax NS" — and the region on the end is noise once events are being
 * grouped by it. regions.ts already knows which trailing words are a region or
 * a postcode in whichever country the user is in, so this borrows that rather
 * than growing a second idea of one.
 */
function displayName(name: string): string {
  return stripRegionAndPostcode(name.trim()) || name.trim();
}

/**
 * The towns to round to, taken from settings.
 *
 * An area entered as a bare name is positioned by `positionOf`, which the
 * server hands the geocode cache that refreshes fill in. It is passed in
 * rather than reached for so this module stays free of the database and can
 * be tested on its own, like regions.ts and venues.ts beside it. An area
 * nobody has ever looked up still works, by name rather than by distance,
 * which is why the coordinates here are allowed to be null.
 */
export function hubsFromSettings(
  settings: {
    city: string;
    lat: number | null;
    lng: number | null;
    radiusKm: number;
    eventAreas?: { name: string; lat?: number; lng?: number; radiusKm?: number }[];
  },
  positionOf: (name: string) => { lat: number; lng: number } | null = () => null
): Hub[] {
  const hubs: Hub[] = [];
  const add = (name: string, lat: number | null, lng: number | null, radiusKm: number): void => {
    const label = displayName(name);
    if (!label || hubs.some((h) => key(h.name) === key(label))) return;
    hubs.push({ name: label, lat, lng, radiusKm: radiusKm > 0 ? radiusKm : 25 });
  };

  add(settings.city, settings.lat, settings.lng, settings.radiusKm);
  for (const area of settings.eventAreas ?? []) {
    const name = (area.name ?? '').trim();
    if (!name) continue;
    let lat = area.lat ?? null;
    let lng = area.lng ?? null;
    if (lat == null || lng == null) {
      const hit = positionOf(name);
      if (hit) {
        lat = hit.lat;
        lng = hit.lng;
      }
    }
    add(name, lat, lng, area.radiusKm ?? settings.radiusKm);
  }
  return hubs;
}

/**
 * The town each event rounds to, in the order the events were given.
 *
 * The decision is made per locality rather than per event, so that every
 * listing in a suburb ends up in the same place whether or not that particular
 * listing was ever given coordinates — half of them never are, since the
 * geocoder refuses any result outside a search area and simply stores nothing
 * for the rest. A locality is settled by:
 *
 * 1. Being one of the towns itself.
 * 2. Where its positioned listings landed, if they sit close enough together
 *    to be one suburb. This is what rounds Llanarth to Bathurst and
 *    Jamisontown to Penrith without either being written down anywhere.
 *    Further out than TOWN_REACH_KM it is a town of its own inside the area,
 *    and keeps its name: Portland is in the Bathurst area, not in Bathurst.
 * 3. A town named in the tail of the address. Only the components after the
 *    first are read: streets lead an address and towns follow one, so this
 *    cannot mistake Penrith Grove in Liverpool for Penrith.
 *
 * Anything still unsettled is elsewhere — except that a locality with enough
 * listings to its name gets an entry of its own, so the fifty scattered across
 * Sydney stay findable instead of disappearing into the far-away bucket.
 */
export function assignPlaces(events: Placeable[], hubs: Hub[], ownBucketMin = OWN_BUCKET_MIN): string[] {
  return placeEvents(events, hubs, ownBucketMin).map((p) => p.place);
}

/** assignPlaces, with the area each event lies in as well as the name it goes by. */
export function placeEvents(events: Placeable[], hubs: Hub[], ownBucketMin = OWN_BUCKET_MIN): Placed[] {
  const positioned = hubs.filter((h) => h.lat != null && h.lng != null);

  // The nearest town an event's own coordinates put it in, if any is close
  // enough to have been worth the drive.
  const byCoords = events.map((ev) => {
    if (ev.lat == null || ev.lng == null) return ELSEWHERE;
    let best = ELSEWHERE;
    let bestKm = Infinity;
    for (const hub of positioned) {
      const km = haversineKm(ev.lat, ev.lng, hub.lat as number, hub.lng as number);
      if (km <= hub.radiusKm && km < bestKm) {
        best = hub.name;
        bestKm = km;
      }
    }
    return best;
  });

  const byLocality = new Map<string, number[]>();
  events.forEach((ev, i) => {
    const k = key(ev.locality);
    if (!k) return;
    const list = byLocality.get(k);
    if (list) list.push(i);
    else byLocality.set(k, [i]);
  });

  const byName = new Map(hubs.map((h) => [key(h.name), h.name]));
  const settled = new Map<string, Placed>();
  for (const [k, indices] of byLocality) {
    const named = byName.get(k);
    if (named) {
      settled.set(k, inArea(named));
      continue;
    }
    const placed = indices.filter((i) => byCoords[i]);
    if (placed.length === 0) continue;
    // Too spread out to be one suburb: this is a city's name doing duty as an
    // address, and the positions behind it were invented by the geocoder. It
    // gets to stand on its own rather than filing a city under a town.
    if (spreadKm(placed.map((i) => events[i])) > SUBURB_SPREAD_KM) {
      settled.set(k, NOWHERE);
      continue;
    }
    const area = commonest(placed.map((i) => byCoords[i]));
    const hub = positioned.find((h) => h.name === area) as Hub;
    const km =
      placed.reduce(
        (sum, i) => sum + haversineKm(events[i].lat as number, events[i].lng as number, hub.lat as number, hub.lng as number),
        0
      ) / placed.length;
    settled.set(k, km > TOWN_REACH_KM ? { place: events[indices[0]].locality.trim(), area } : inArea(area));
  }

  const places = events.map((ev, i): Placed => {
    const k = key(ev.locality);
    const known = k ? settled.get(k) : undefined;
    if (known !== undefined) return known;
    // Coordinates have already had their say, whichever way it went; only a
    // listing that never had any falls through to matching on name.
    return inArea(byCoords[i] || (ev.lat == null ? hubNamedIn(ev, hubs) : ELSEWHERE));
  });

  const leftovers = new Map<string, { label: string; count: number }>();
  events.forEach((ev, i) => {
    const k = key(ev.locality);
    if (places[i].place || !k) return;
    const entry = leftovers.get(k) ?? { label: ev.locality.trim(), count: 0 };
    entry.count++;
    leftovers.set(k, entry);
  });
  for (const [k, { label, count }] of leftovers) {
    if (count < ownBucketMin) continue;
    events.forEach((ev, i) => {
      if (!places[i].place && key(ev.locality) === k) places[i] = { place: label, area: ELSEWHERE };
    });
  }

  return places;
}

/** The widest gap between any two of these positions, in kilometres. */
function spreadKm(events: Placeable[]): number {
  let widest = 0;
  for (const a of events) {
    for (const b of events) {
      if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) continue;
      widest = Math.max(widest, haversineKm(a.lat, a.lng, b.lat, b.lng));
    }
  }
  return widest;
}

/** The most frequent name, ties going to the alphabetically first. */
function commonest(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/** The town named in an event's locality or in the tail of its address. */
function hubNamedIn(ev: Placeable, hubs: Hub[]): string {
  const parts = ev.address.split(',').map((p) => p.trim()).filter(Boolean);
  const text = words([ev.locality, ...parts.slice(1)].join(' '));
  if (text.length === 0) return ELSEWHERE;
  for (const hub of hubs) {
    if (containsWords(text, words(hub.name))) return hub.name;
  }
  return ELSEWHERE;
}
