import { isCountry, isPostcode, isRegion } from './regions.js';

/** Words that only ever appear as part of a longer region name. */
const REGION_WORDS = new Set(['new', 'south', 'north', 'east', 'west', 'wales', 'territory', 'capital', 'island', 'columbia']);

/**
 * One venue, one name.
 *
 * Sources name the same place every way they can think of. Mount Panorama
 * arrived as seven venues — "Mount Panorama", "Mount Panorama Circuit",
 * "Mount Panorama Bathurst", "Mount Panorama Motor Racing Circuit", "Mount
 * Panorama Racing Circuit, Bathurst, NSW, Australia", "Panorama Bathurst" and
 * "Mount Panorama, Bathurst" — which is seven headings in the by-place sort,
 * seven rows on the map, and seven chances for a dedupe to miss.
 *
 * Coordinates cannot settle it: those seven carried positions up to 3 km
 * apart, well past any sane radius, because each was geocoded from its own
 * spelling. So the names are matched against each other instead.
 */

/**
 * Words that describe what a venue is rather than which one it is. Dropping
 * them lets "Mount Panorama" meet "Mount Panorama Motor Racing Circuit".
 *
 * Deliberately short. "Showground", "Park", "Hotel" and "Centre" are NOT here:
 * Bathurst Showground is not Bathurst, and folding those would merge places
 * that only share a town.
 */
const GENERIC = new Set(['circuit', 'racing', 'motor', 'club', 'inc', 'ltd', 'pty', 'co']);

/**
 * Leading words that sources drop at will — "Mount Panorama" is written
 * "Panorama Bathurst" by at least one of them.
 */
const NOISE = new Set(['the', 'mount', 'mt', 'st', 'saint']);

/** Trailing scraps: "s/s", a bracketed aside, an acronym after a dash. */
function trimTail(name: string): string {
  return name
    .replace(/\s+-\s+[A-Z]{2,8}\s*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+s\/s\s*$/i, '')
    .trim();
}

/**
 * The comparable core of a venue name: its distinguishing words, sorted.
 *
 * Only the part before the first comma is read. A name like "Mount Panorama
 * Racing Circuit, Bathurst, NSW, Australia" is a venue with an address glued
 * on, and the address is what makes it look unique.
 */
export function venueKey(name: string): string[] {
  return trimTail(name.split(',')[0])
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !GENERIC.has(w) && !NOISE.has(w))
    .sort();
}

/**
 * Whether `a` is the same place as `b`, said with fewer words.
 *
 * True when every word of `a` appears in `b` and the words `b` adds are all
 * town names. That last condition is the whole safety of this: "Mount
 * Panorama" and "Mount Panorama Bathurst" differ only by a town, so they
 * merge, while "Rydges Mount Panorama" adds "rydges" — a hotel across the
 * valley from the circuit, and a place in its own right — so it does not.
 */
function absorbs(a: string[], b: string[], localities: Set<string>): boolean {
  if (a.length === 0 || a.length > b.length) return false;
  if (!a.every((w) => b.includes(w))) return false;
  const extra = b.filter((w) => !a.includes(w));
  return extra.length > 0 && extra.every((w) => localities.has(w));
}

/**
 * Map every venue spelling to the one spelling that will be used for it.
 *
 * Clusters are merged transitively, so "Panorama Bathurst" reaching "Mount
 * Panorama" pulls in everything else already on it. The spelling that wins is
 * the most frequently used one — that is the name already recognisable — and
 * a tie goes to the shorter, since what separates two equally common
 * spellings is almost always something stapled to the end of one of them
 * ("Orange Showground" against "Orange Showground s/s").
 */
export function unifyVenueNames(
  venues: { name: string; count: number }[],
  localities: Iterable<string>
): Map<string, string> {
  const localitySet = new Set([...localities].map((l) => l.toLowerCase()));
  const named = venues
    .filter((v) => v.name.trim())
    .map((v) => ({ ...v, key: venueKey(v.name) }))
    .filter((v) => v.key.length > 0);

  // Cluster ids, merged as pairs are found to describe the same place.
  const cluster = new Map<string, number>();
  named.forEach((v, i) => cluster.set(v.name, i));
  const rename = (from: number, to: number): void => {
    for (const [name, id] of cluster) if (id === from) cluster.set(name, to);
  };

  for (const a of named) {
    for (const b of named) {
      if (a.name === b.name) continue;
      const same =
        a.key.join(' ') === b.key.join(' ') ||
        absorbs(a.key, b.key, localitySet) ||
        absorbs(b.key, a.key, localitySet);
      if (!same) continue;
      const ia = cluster.get(a.name)!;
      const ib = cluster.get(b.name)!;
      if (ia !== ib) rename(Math.max(ia, ib), Math.min(ia, ib));
    }
  }

  const byCluster = new Map<number, typeof named>();
  for (const v of named) {
    const id = cluster.get(v.name)!;
    const list = byCluster.get(id);
    if (list) list.push(v);
    else byCluster.set(id, [v]);
  }

  const out = new Map<string, string>();
  for (const list of byCluster.values()) {
    if (list.length < 2) continue;
    const winner = list.slice().sort(
      (x, y) => y.count - x.count || x.name.length - y.name.length || x.name.localeCompare(y.name)
    )[0];
    for (const v of list) if (v.name !== winner.name) out.set(v.name, winner.name);
  }
  return out;
}

/**
 * Town names to treat as "same place, said with the town attached".
 *
 * Drawn from the areas being searched rather than a list baked in here, so it
 * follows the user's settings — plus the localities the addresses themselves
 * name, which is how suburbs like Kelso get counted without being configured.
 */
export function localitiesFrom(areaNames: string[], addresses: string[]): Set<string> {
  const out = new Set<string>();
  const add = (text: string): void => {
    // Region abbreviations ride along on area names ("Penrith NSW"), and the
    // long forms arrive split across words ("New South Wales"), so both the
    // whole component and each word are checked.
    if (isRegion(text) || isCountry(text)) return;
    for (const word of text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
      if (word.length > 2 && !isRegion(word) && !isCountry(word) && !REGION_WORDS.has(word)) out.add(word);
    }
  };
  for (const name of areaNames) add(name);

  // A component that shows up late in several addresses is a town, not a
  // street: streets lead an address, towns follow one.
  const seen = new Map<string, number>();
  for (const address of addresses) {
    const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
    for (const part of parts.slice(1)) {
      if (/\d/.test(part) || part.split(/\s+/).length > 3) continue;
      if (isRegion(part) || isCountry(part) || isPostcode(part)) continue;
      const key = part.toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const [part, count] of seen) if (count >= 3) add(part);
  return out;
}
