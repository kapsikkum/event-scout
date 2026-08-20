import crypto from 'node:crypto';
import { db } from './db.js';
import { consensusStart } from './validate.js';
import { localityOf } from './regions.js';

export interface EventRow {
  id: number;
  source: string;
  source_id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string | null;
  venue_name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  url: string;
  image_url: string;
  category: string;
  price_text: string;
  is_online: number;
  photo_score: number;
  archived: number;
  archived_at: string | null;
  starred: number;
  hidden: number;
  dedupe_group: string;
  manual_group: string;
}

export interface EventMember {
  id: number;
  source: string;
  title: string;
  url: string;
  imageUrl: string;
  startTime: string;
  venueName: string;
}

export interface MergedEvent {
  group: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string | null;
  venueName: string;
  address: string;
  /** The suburb or town the address names, '' when it names none. */
  locality: string;
  lat: number | null;
  lng: number | null;
  imageUrl: string;
  category: string;
  priceText: string;
  isOnline: boolean;
  photoScore: number;
  starred: boolean;
  hidden: boolean;
  sources: { source: string; url: string }[];
  /** Every distinct image across the members, best first. */
  images: string[];
  /** The listings behind this event, so a merge can be reviewed and undone. */
  members: EventMember[];
  /** True when a person merged these rather than the deduper. */
  manual: boolean;
}

/**
 * The key an event row groups under.
 *
 * A manual merge wins over the automatic one: the deduper reruns on every
 * refresh and would otherwise pull a hand-merged pair back apart.
 */
function groupKey(row: EventRow): string {
  return row.manual_group || row.dedupe_group || `solo-${row.id}`;
}

/**
 * Merge rows sharing a group into one event, preferring the richest fields.
 * Archived (past) events are excluded unless explicitly asked for.
 */
export function getMergedEvents(opts: { archived?: boolean } = {}): MergedEvent[] {
  const archived = opts.archived ? 1 : 0;
  const rows = db
    .prepare('SELECT * FROM events WHERE archived = ? ORDER BY start_time ASC')
    .all(archived) as unknown as EventRow[];

  const byGroup = new Map<string, EventRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const list = byGroup.get(key);
    if (list) list.push(row);
    else byGroup.set(key, [row]);
  }

  const merged: MergedEvent[] = [];
  for (const [group, members] of byGroup) {
    const pick = <T>(get: (r: EventRow) => T, nonEmpty: (v: T) => boolean): T => {
      for (const m of members) {
        const v = get(m);
        if (nonEmpty(v)) return v;
      }
      return get(members[0]);
    };
    const str = (get: (r: EventRow) => string) => pick(get, (v) => Boolean(v && v.length));
    const longestDesc = members.reduce((best, m) => (m.description.length > best.length ? m.description : best), '');
    // A merge is worth doing partly for this: a listing with no picture
    // inherits one from its twin. Distinct images are kept so nothing is lost.
    const images = [...new Set(members.map((m) => m.image_url).filter(Boolean))];

    merged.push({
      group,
      title: str((r) => r.title),
      description: longestDesc,
      // Not members[0]: rows arrive sorted by start, so a lone listing with a
      // date a day early would set the whole group's day. The date most
      // members agree on is the one to show.
      startTime: consensusStart(members.map((m) => m.start_time)),
      endTime: members.find((m) => m.end_time)?.end_time ?? null,
      venueName: str((r) => r.venue_name),
      address: str((r) => r.address),
      // Derived here rather than in the browser: reading a locality out of an
      // address means knowing every country's postal tail, and that table
      // belongs in one place. See regions.ts. The venue field is tried too,
      // because a good few sources put the street address in it and leave the
      // address empty — those are exactly the rows that need a locality most,
      // since without one they head their own group by street number.
      locality: localityOf(str((r) => r.address)) || localityOf(str((r) => r.venue_name)),
      lat: members.find((m) => m.lat != null)?.lat ?? null,
      lng: members.find((m) => m.lng != null)?.lng ?? null,
      imageUrl: images[0] ?? '',
      images,
      category: str((r) => r.category),
      priceText: str((r) => r.price_text),
      isOnline: members.every((m) => m.is_online === 1),
      photoScore: Math.max(...members.map((m) => m.photo_score)),
      starred: members.some((m) => m.starred === 1),
      hidden: members.some((m) => m.hidden === 1),
      sources: members.map((m) => ({ source: m.source, url: m.url })),
      members: members.map((m) => ({
        id: m.id,
        source: m.source,
        title: m.title,
        url: m.url,
        imageUrl: m.image_url,
        startTime: m.start_time,
        venueName: m.venue_name,
      })),
      manual: Boolean(members[0].manual_group),
    });
  }
  merged.sort((a, b) =>
    opts.archived ? b.startTime.localeCompare(a.startTime) : a.startTime.localeCompare(b.startTime)
  );
  return merged;
}

/** The rows behind a group key, whichever kind of group it is. */
function memberRows(group: string): EventRow[] {
  if (group.startsWith('solo-')) {
    const row = db
      .prepare("SELECT * FROM events WHERE id = ? AND manual_group = ''")
      .get(Number(group.slice(5))) as unknown as EventRow | undefined;
    return row ? [row] : [];
  }
  return db
    .prepare(
      "SELECT * FROM events WHERE manual_group = ? OR (manual_group = '' AND dedupe_group = ?)"
    )
    .all(group, group) as unknown as EventRow[];
}

export function setGroupFlag(group: string, flag: 'starred' | 'hidden', value: boolean): void {
  const ids = memberRows(group).map((r) => r.id);
  if (ids.length === 0) return;
  const stmt = db.prepare(`UPDATE events SET ${flag} = ? WHERE id = ?`);
  for (const id of ids) stmt.run(value ? 1 : 0, id);
}

/**
 * Merge several groups into one.
 *
 * Every row behind every group is stamped with a shared manual group, so
 * merging an already-merged event folds its members in too. The id is derived
 * from the member ids, which makes the same merge idempotent.
 */
export function mergeGroups(groups: string[]): { group: string; merged: number } {
  const ids = [...new Set(groups.flatMap((g) => memberRows(g).map((r) => r.id)))].sort((a, b) => a - b);
  if (ids.length < 2) throw new Error('Merging needs at least two distinct events');

  const manual = 'm' + crypto.createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 15);
  const stmt = db.prepare('UPDATE events SET manual_group = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(manual, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { group: manual, merged: ids.length };
}

/**
 * Undo a manual merge. The members fall back to whatever the deduper says,
 * which may still hold some of them together — that is the correct outcome,
 * since those were duplicates before anyone intervened.
 */
export function unmergeGroup(group: string): { split: number } {
  const info = db.prepare("UPDATE events SET manual_group = '' WHERE manual_group = ?").run(group);
  return { split: Number(info.changes) };
}
