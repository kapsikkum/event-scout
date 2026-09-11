import crypto from 'node:crypto';
import { db, getSettings } from './db.js';
import { groupStart, isOver } from './validate.js';
import { normalizeTitle } from './dedupe.js';
import { localityOf } from './regions.js';
import { flyerHref } from './flyers.js';
import { storedPath } from './flyerStore.js';
import { assignPlaces, hubsFromSettings } from './places.js';
import { cachedGeocode } from './geocode.js';
import { chooseFields, EditError, parseEditPatch } from './merge.js';
import type { EditableField } from './merge.js';

export { EditError } from './merge.js';
import type { EnrichedBy, EventRow } from './merge.js';

// Re-exported so an event's shape stays importable from one place.
export { chooseFields } from './merge.js';
export type { ChosenFields, EnrichedBy, EventRow } from './merge.js';

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
  /**
   * The town this rounds to, out of the ones the user searches. '' means
   * nowhere near any of them. See places.ts.
   */
  place: string;
  lat: number | null;
  lng: number | null;
  imageUrl: string;
  category: string;
  priceText: string;
  isOnline: boolean;
  /**
   * The start carries a day and no clock time: the listing said "Thursday"
   * and nothing more. Shown as the day alone rather than a made-up hour.
   */
  dateOnly: boolean;
  photoScore: number;
  starred: boolean;
  hidden: boolean;
  /**
   * When the first of its listings was found, or null when one of them
   * predates the app keeping track. The earliest rather than the latest: a
   * second site listing an event already known is not a new event.
   */
  firstSeenAt: string | null;
  sources: { source: string; url: string }[];
  /** Every distinct image across the members, best first. */
  images: string[];
  /** The listings behind this event, so a merge can be reviewed and undone. */
  members: EventMember[];
  /** True when a person merged these rather than the deduper. */
  manual: boolean;
  /**
   * The repeating series this is one date of: the same name at the same place.
   * Every date is its own event — the calendar needs them apart — and the
   * Events page folds a series into one card. See seriesKey.
   */
  series: string;
  /**
   * A line of practical detail read off the flyer — when gates open, which
   * entrance to use. Shown as it is; nothing is derived from it, least of all
   * the start time, which flyers and models between them get wrong.
   */
  note: string;
  /**
   * Which of the fields above you are reading a model's answer for.
   *
   * The columns have always been kept apart in the database, but everything
   * above this line is the result of choosing between them, and by the time it
   * reaches a reader a rewritten blurb looks exactly like a scraped one. This
   * says which is which: `model` for the text pass, `flyer` for the vision one.
   * Absent fields are as the source published them.
   */
  enriched: Record<string, EnrichedBy>;
  /**
   * The fields a person changed by hand, in edit mode. These beat the scraped
   * value, the flyer and the model alike, and clearing one puts back whatever
   * would have been shown.
   */
  edited: string[];
  /**
   * The blurb as published, when what is shown is not it — a model rewrote it,
   * or someone edited it. '' when the two are the same. The page offers it as a
   * toggle, so a rewrite that lost something can be read as it was written.
   */
  rawDescription: string;
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
 * The same name at the same place, on whatever day.
 *
 * Orange council publishes a page per date for a class that runs all term —
 * /event/highland-dancing-classes-during-school-terms/2026-09-11/, then the
 * 15th, then the 18th — so it arrives as twenty-seven listings with twenty-
 * seven addresses, and the deduper, rightly, keeps listings on different days
 * apart. This is the key that says they are one thing happening repeatedly.
 */
function seriesKey(title: string, place: string): string {
  return crypto
    .createHash('sha1')
    .update(`${normalizeTitle(title)}|${normalizeTitle(place)}`)
    .digest('hex')
    .slice(0, 16);
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
    const chosen = chooseFields(members);
    const bestDescription = chosen.description;
    const { venueName, address, note, enriched } = chosen;
    // A merge is worth doing partly for this: a listing with no picture
    // inherits one from its twin. Distinct images are kept so nothing is lost.
    const images = [...new Set(members.map((m) => m.image_url).filter(Boolean))];
    // The stored copies go last, so the original is still preferred and the
    // copy is only reached when the browser finds the original will not load.
    // EventImage walks this list on error, so the fallback costs nothing here.
    for (const m of members) {
      if (!m.image_url) continue;
      const kept = storedPath(m.image_url, m.start_time);
      if (kept) images.push(flyerHref(kept));
    }

    // Derived here rather than in the browser: reading a locality out of an
    // address means knowing every country's postal tail, and that table
    // belongs in one place. See regions.ts. The venue field is tried too,
    // because a good few sources put the street address in it and leave the
    // address empty — those are exactly the rows that need a locality most,
    // since without one they head their own group by street number.
    const locality = localityOf(address) || localityOf(venueName);

    merged.push({
      group,
      title: chosen.title,
      description: bestDescription,
      // Not members[0]: rows arrive sorted by start, so a lone listing with a
      // date a day early would set the whole group's day. The date most
      // members agree on is the one to show.
      ...groupStart(members, chosen.startTime),
      endTime: members.find((m) => m.end_time)?.end_time ?? null,
      venueName,
      address,
      locality,
      // Filled in below, once every event is known: which town an event
      // rounds to depends on what the others taught about its suburb.
      place: '',
      lat: members.find((m) => m.lat != null)?.lat ?? null,
      lng: members.find((m) => m.lng != null)?.lng ?? null,
      imageUrl: chosen.imageUrl ?? images[0] ?? '',
      images,
      category: chosen.category,
      priceText: chosen.priceText,
      isOnline: members.every((m) => m.is_online === 1),
      photoScore: chosen.photoScore,
      starred: members.some((m) => m.starred === 1),
      hidden: members.some((m) => m.hidden === 1),
      firstSeenAt: members.some((m) => !m.first_seen_at)
        ? null
        : members.map((m) => m.first_seen_at as string).sort()[0],
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
      series: seriesKey(chosen.title, venueName || locality || address),
      note,
      enriched,
      edited: chosen.edited,
      rawDescription: chosen.rawDescription === bestDescription ? '' : chosen.rawDescription,
    });
  }
  // Events that have been and gone are dropped here as well as archived on a
  // timer, so the list is right the moment it is read. Archiving used to be
  // the only thing that removed them and it only ran inside a refresh — so a
  // refresh that failed, or simply was not due, left yesterday at the top of
  // the page. See isOver and archivePastEvents.
  const live = opts.archived ? merged : merged.filter((ev) => !isOver(ev.startTime, ev.endTime));

  // After the past ones are gone, so that a town is offered on the strength of
  // the events still to come rather than of last month's.
  const hubs = hubsFromSettings(getSettings(), (name) => cachedGeocode(name)?.[0] ?? null);
  assignPlaces(live, hubs).forEach((place, i) => {
    live[i].place = place;
  });

  live.sort((a, b) =>
    opts.archived ? b.startTime.localeCompare(a.startTime) : a.startTime.localeCompare(b.startTime)
  );
  return live;
}

/**
 * One event by its group key, upcoming or past.
 *
 * Merged through the same path as the list rather than assembled from the rows
 * directly, because `place` is decided by looking at every other event — a
 * suburb rounds to a town on the strength of what its neighbours taught. Built
 * alone it would sometimes differ from the same event in the list, which is a
 * worse trade than the cost of merging twice.
 */
export function getMergedEvent(group: string): MergedEvent | undefined {
  return (
    getMergedEvents().find((ev) => ev.group === group) ??
    getMergedEvents({ archived: true }).find((ev) => ev.group === group)
  );
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

/** Wire field name -> the column its override lives in. */
const EDIT_COLUMNS: Record<EditableField, string> = {
  title: 'edit_title',
  description: 'edit_description',
  startTime: 'edit_start_time',
  venueName: 'edit_venue_name',
  address: 'edit_address',
  category: 'edit_category',
  priceText: 'edit_price_text',
  imageUrl: 'edit_image_url',
  photoScore: 'edit_photo_score',
};

/**
 * Save hand edits onto every listing behind an event.
 *
 * Written to all the members rather than against the group, because a group id
 * is derived from the title and the date — edit either and the id changes, and
 * an override stored against the old one would be orphaned by the very edit
 * that made it. The rows outlive that, which is why starred and hidden live
 * there too.
 */
export function editGroup(group: string, patch: Record<string, unknown>): { updated: EditableField[] } {
  const ids = memberRows(group).map((r) => r.id);
  if (ids.length === 0) throw new EditError(`Unknown event: ${group}`);

  const edits = parseEditPatch(patch);
  const sets: string[] = [];
  const values: (string | number)[] = [];
  for (const { field, value } of edits) {
    // The column name comes from this table, never from the request.
    const column = EDIT_COLUMNS[field];
    if (value === null) {
      sets.push(`${column} = NULL`);
    } else {
      sets.push(`${column} = ?`);
      values.push(value);
    }
  }

  const stmt = db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`);
  db.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(...values, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { updated: edits.map((e) => e.field) };
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
