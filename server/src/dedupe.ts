import { localDay } from './day.js';
import crypto from 'node:crypto';

export interface DedupeInput {
  id: number;
  title: string;
  startTime: string;
  lat: number | null;
  lng: number | null;
  /** For the second pass: the same place, however each listing spelled it. */
  venueName?: string | null;
  /** A day with no time is never matched on its start: every one is midnight. */
  dateOnly?: number | boolean | null;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'at', 'of', 'in', 'on', 'and', '&', 'with', 'presents', 'live', 'tour', 'show']);

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ');
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Words that say what kind of listing it is, not which event. */
const GENERIC_WORDS = new Set([
  'concert', 'support', 'supported', 'featuring', 'feat', 'special', 'guest', 'guests', 'night', 'event',
  'music', 'gig', 'ticket', 'edition', 'annual', 'free', 'entry', 'pres', 'presented', 'plus', 'for',
  'day', 'from', 'by', 'to', 'our', 'your', 'all', 'new',
]);
/** Words in a venue's name that every venue of its kind shares. */
const GENERIC_VENUE_WORDS = new Set([
  'hotel', 'pub', 'irish', 'club', 'bar', 'inn', 'tavern', 'park', 'hall', 'centre', 'center', 'theatre',
  'theater', 'street', 'road', 'showground', 'oval', 'reserve', 'rsl', 'bowling', 'leagues', 'sports',
]);

/** "Duggans" and "Duggan" are one word. */
const stem = (w: string): string => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

function words(text: string | null | undefined): Set<string> {
  return new Set(
    normalizeTitle(text ?? '')
      .split(' ')
      .map(stem)
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w))
  );
}

function samePlace(a: DedupeInput, b: DedupeInput): boolean {
  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    return haversineKm(a.lat, a.lng, b.lat, b.lng) <= 0.3;
  }
  const va = [...words(a.venueName)].filter((w) => !GENERIC_VENUE_WORDS.has(w));
  const vb = new Set([...words(b.venueName)].filter((w) => !GENERIC_VENUE_WORDS.has(w)));
  return va.some((w) => vb.has(w));
}

/**
 * Whether two titles name the same event, the venue's own words set aside.
 *
 * Three conditions, each earned on the live data:
 *
 *   - at least two distinctive words in common ("kavisha", "mazzella");
 *   - one title adds at most one word the other lacks. Two New Year's Eve
 *     cruises from the same wharf at the same time share "sydney fireworks
 *     cruise", but one is MV Bubbles and the other Whale Dreamer — each has
 *     words the other does not, and they are two boats;
 *   - no clash of numbers. "8:30AM Shotgun Start" and "1:00PM Shotgun Start"
 *     are the same words about two different sessions.
 */
function titlesMatch(a: DedupeInput, b: DedupeInput): boolean {
  const venue = new Set([...words(a.venueName), ...words(b.venueName)]);
  const ta = new Set([...words(a.title)].filter((w) => !venue.has(w)));
  const tb = new Set([...words(b.title)].filter((w) => !venue.has(w)));
  const shared = [...ta].filter((w) => tb.has(w)).length;
  if (shared < 2) return false;
  const onlyA = [...ta].filter((w) => !tb.has(w));
  const onlyB = [...tb].filter((w) => !ta.has(w));
  if (Math.min(onlyA.length, onlyB.length) > 1) return false;
  const numbered = (list: string[]): boolean => list.some((w) => /\d/.test(w));
  return !(numbered(onlyA) && numbered(onlyB));
}

/**
 * The same event under two titles.
 *
 * "Kavisha Mazzella live at Jack Duggans" and "Kavisha Mazzella in concert
 * with Support The Skinks", both 7:30pm on the 16th at one pub, were two cards:
 * the first pass needs the titles to match exactly. So a second: the same start
 * to the minute, the same place — within 300 m, or a venue name in common —
 * and at least two distinctive words in both titles once the venue's own are
 * set aside. The exact minute is what makes the rest safe; a day with no time
 * is midnight for every listing, and is never matched this way.
 */
function mergeAcrossTitles(events: DedupeInput[], result: Map<number, string>): void {
  const parent = new Map<string, string>();
  const find = (g: string): string => {
    let root = g;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(g, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // The smaller id wins, so the same events always end up with the same group.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  const byStart = new Map<string, DedupeInput[]>();
  for (const ev of events) {
    if (ev.dateOnly) continue;
    const list = byStart.get(ev.startTime);
    if (list) list.push(ev);
    else byStart.set(ev.startTime, [ev]);
  }
  for (const list of byStart.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ga = result.get(a.id)!;
        const gb = result.get(b.id)!;
        if (find(ga) === find(gb)) continue;
        if (samePlace(a, b) && titlesMatch(a, b)) union(ga, gb);
      }
    }
  }
  if (parent.size === 0) return;
  for (const [id, group] of result) result.set(id, find(group));
}

/**
 * Assigns a dedupe group id to each event. Events match when their normalized
 * title and calendar date agree, and their venues are within 300m (events
 * missing coordinates match on title+date alone) — or, failing that, when they
 * start at the same minute at the same place under titles that share their
 * distinctive words. See mergeAcrossTitles.
 */
export function assignDedupeGroups(events: DedupeInput[]): Map<number, string> {
  const result = new Map<number, string>();
  const byKey = new Map<string, DedupeInput[][]>(); // key -> clusters

  for (const ev of events) {
    // The local day, not the UTC one: a 10am start here is the previous
    // evening in UTC, and a listing that gave only the date is stored at
    // local midnight — on the UTC day before. See day.ts.
    const date = localDay(ev.startTime);
    const key = `${normalizeTitle(ev.title)}|${date}`;
    let clusters = byKey.get(key);
    if (!clusters) {
      clusters = [];
      byKey.set(key, clusters);
    }
    let placed = false;
    for (const cluster of clusters) {
      const compatible = cluster.every((other) => {
        if (ev.lat == null || ev.lng == null || other.lat == null || other.lng == null) return true;
        return haversineKm(ev.lat, ev.lng, other.lat, other.lng) <= 0.3;
      });
      if (compatible) {
        cluster.push(ev);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([ev]);
  }

  for (const [key, clusters] of byKey) {
    clusters.forEach((cluster, i) => {
      const group = crypto.createHash('sha1').update(`${key}#${i}`).digest('hex').slice(0, 16);
      for (const ev of cluster) result.set(ev.id, group);
    });
  }
  mergeAcrossTitles(events, result);
  return result;
}
