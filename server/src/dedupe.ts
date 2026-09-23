import { haversineKm } from './shared/geo.js';
import { localDay } from './day.js';
import crypto from 'node:crypto';

export interface DedupeInput {
  id: number;
  title: string;
  startTime: string;
  endTime?: string | null;
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
    .replace(/\b20\d\d\b/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ');
}

function splitTitleSegments(title: string): string[] {
  return title.split(/\s*\|\s*|\s+[-–—]\s+/);
}

/** The prefix of a pipelined title before the first ' | ' or ' - ', normalized. */
export function coreTitle(title: string): string {
  const parts = splitTitleSegments(title);
  return normalizeTitle(parts[0].trim());
}

export function extractVenueFromTitle(title: string): string | null {
  const parts = splitTitleSegments(title);
  if (parts.length >= 2) {
    const trailing = parts[parts.length - 1].trim();
    if (trailing.length > 0) return trailing;
  }
  return null;
}

/** The part of a pipelined title after the LAST ' | ', cleaned as a venue name. */
function titleVenue(title: string): string {
  const parts = title.split(' | ');
  if (parts.length < 2) return '';
  return parts[parts.length - 1].trim();
}

function effectiveVenue(ev: DedupeInput): string | null {
  if (ev.venueName != null && ev.venueName.trim() !== '') {
    return ev.venueName.trim();
  }
  return extractVenueFromTitle(ev.title);
}

interface DateSpan {
  startDay: string;
  endDay: string;
}

function eventDateSpan(ev: DedupeInput): DateSpan {
  const startDay = localDay(ev.startTime);
  const endDay = ev.endTime ? localDay(ev.endTime) : startDay;
  return {
    startDay,
    endDay: endDay < startDay ? startDay : endDay,
  };
}

function datesOverlap(a: DedupeInput, b: DedupeInput): boolean {
  const spanA = eventDateSpan(a);
  const spanB = eventDateSpan(b);
  return spanA.startDay <= spanB.endDay && spanB.startDay <= spanA.endDay;
}

/** Whether two events' date spans overlap (true for point events that share a day). */
function spansOverlap(a: DedupeInput, b: DedupeInput): boolean {
  const aStart = Date.parse(a.startTime);
  const aEnd = a.endTime ? Date.parse(a.endTime) : aStart;
  const bStart = Date.parse(b.startTime);
  const bEnd = b.endTime ? Date.parse(b.endTime) : bStart;
  return aStart <= bEnd && bStart <= aEnd;
}

function isPrefixTitleMatch(a: DedupeInput, b: DedupeInput): boolean {
  const normA = normalizeTitle(a.title);
  const normB = normalizeTitle(b.title);
  if (!normA || !normB) return false;

  const coreA = coreTitle(a.title);
  const coreB = coreTitle(b.title);

  // One title has the other as its prefix before ` | ` or ` - `
  if (normA === coreB && normB !== coreB) return true;
  if (normB === coreA && normA !== coreA) return true;
  return false;
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
  // Supplement empty venue names with venues extracted from pipelined titles
  const venA = a.venueName || titleVenue(a.title);
  const venB = b.venueName || titleVenue(b.title);
  const va = [...words(venA)].filter((w) => !GENERIC_VENUE_WORDS.has(w));
  const vb = new Set([...words(venB)].filter((w) => !GENERIC_VENUE_WORDS.has(w)));
  const shareVenue = va.some((w) => vb.has(w));

  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
    return km <= 0.6 || (km <= 5.0 && shareVenue);
  }
  return shareVenue;
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

  // 1. Overlapping date-span matching for multi-day events with matching normalized title at the same venue.
  // Note: dateOnly does not block merging when normalized title and venue match on overlapping dates.
  const byNormTitle = new Map<string, DedupeInput[]>();
  for (const ev of events) {
    const norm = normalizeTitle(ev.title);
    if (!norm) continue;
    const list = byNormTitle.get(norm);
    if (list) list.push(ev);
    else byNormTitle.set(norm, [ev]);
  }
  for (const list of byNormTitle.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ga = result.get(a.id)!;
        const gb = result.get(b.id)!;
        if (find(ga) === find(gb)) continue;
        if (samePlace(a, b) && datesOverlap(a, b)) union(ga, gb);
      }
    }
  }

  // 2. Sub-event / pipelined title merging:
  // Check events on the same day or overlapping date span at the same venue where
  // one title has the other as its prefix before ` | ` or ` - `
  // (e.g. `Challenge Bathurst` and `Challenge Bathurst | Regularity Event | Mount Panorama`).
  // Note: dateOnly does not block merging when core title and venue match on overlapping dates.
  const byCoreTitle = new Map<string, DedupeInput[]>();
  for (const ev of events) {
    const core = coreTitle(ev.title);
    if (!core) continue;
    const list = byCoreTitle.get(core);
    if (list) list.push(ev);
    else byCoreTitle.set(core, [ev]);
  }
  for (const list of byCoreTitle.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ga = result.get(a.id)!;
        const gb = result.get(b.id)!;
        if (find(ga) === find(gb)) continue;
        if (isPrefixTitleMatch(a, b) && samePlace(a, b) && datesOverlap(a, b)) {
          union(ga, gb);
        }
      }
    }
  }

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
  // A post that names an event but not where it is, nor when to the minute —
  // "SMSP OPEN PIT LANE 23 SEPTEMBER" on Instagram — joins the one listing
  // that day whose title matches. Only when there is exactly one: a post
  // saying "cars and coffee" matches every meet that Sunday, and joins none.
  const unplaced = (ev: DedupeInput): boolean => ev.lat == null && !ev.venueName;
  const byDay = new Map<string, DedupeInput[]>();
  for (const ev of events) {
    const day = localDay(ev.startTime);
    const list = byDay.get(day);
    if (list) list.push(ev);
    else byDay.set(day, [ev]);
  }
  for (const list of byDay.values()) {
    for (const a of list) {
      if (!unplaced(a)) continue;
      const groups = new Set(
        list.filter((b) => !unplaced(b) && titlesMatch(a, b)).map((b) => find(result.get(b.id)!))
      );
      if (groups.size === 1) union(result.get(a.id)!, [...groups][0]);
    }
  }

  if (parent.size === 0) return;
  for (const [id, group] of result) result.set(id, find(group));
}

/**
 * Second pass: merge events that share the same core (year-stripped, normalized)
 * title and venue across overlapping date spans.
 *
 * "Challenge Bathurst" and "Challenge Bathurst 2026" both reduce to the same
 * core; events spanning Nov 18-22 and Nov 20-22 at the same circuit merge here.
 */
function mergeAcrossSpans(events: DedupeInput[], result: Map<number, string>): void {
  const parent = new Map<string, string>();
  const find = (g: string): string => {
    let root = g;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(g, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a); const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  // Group events by their normalized (year-stripped) title
  const byNorm = new Map<string, DedupeInput[]>();
  for (const ev of events) {
    const norm = normalizeTitle(ev.title);
    if (!norm || norm.length < 3) continue;
    const list = byNorm.get(norm);
    if (list) list.push(ev); else byNorm.set(norm, [ev]);
  }
  for (const list of byNorm.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const ga = result.get(a.id)!;
        const gb = result.get(b.id)!;
        if (find(ga) === find(gb)) continue;
        // Merge if same normalized title, same venue, overlapping date span
        if (datesOverlap(a, b) && samePlace(a, b)) union(ga, gb);
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
  const sorted = [...events].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id - b.id);
  const result = new Map<number, string>();
  const byKey = new Map<string, DedupeInput[][]>(); // key -> clusters

  for (const ev of sorted) {
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
        const km = haversineKm(ev.lat, ev.lng, other.lat, other.lng);
        if (km <= 0.6) return true;
        const va = [...words(ev.venueName)].filter((w) => !GENERIC_VENUE_WORDS.has(w));
        const vb = new Set([...words(other.venueName)].filter((w) => !GENERIC_VENUE_WORDS.has(w)));
        return km <= 2.0 && va.some((w) => vb.has(w));
      });
      if (compatible) {
        cluster.push(ev);
        cluster.sort((a, b) => a.id - b.id);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([ev]);
  }

  for (const [key, clusters] of byKey) {
    for (const cluster of clusters) {
      cluster.sort((a, b) => a.id - b.id);
    }
    clusters.sort((a, b) => {
      const minA = Math.min(...a.map((e) => e.id));
      const minB = Math.min(...b.map((e) => e.id));
      return minA - minB;
    });
    for (const cluster of clusters) {
      const minId = Math.min(...cluster.map((e) => e.id));
      const group = crypto.createHash('sha1').update(`${key}#${minId}`).digest('hex').slice(0, 16);
      for (const ev of cluster) result.set(ev.id, group);
    }
  }
  mergeAcrossTitles(sorted, result);
  mergeAcrossSpans(sorted, result);
  return result;
}

