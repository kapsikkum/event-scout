import crypto from 'node:crypto';
import { db, getSettings } from './db.js';
import { consensusStart, isOver } from './validate.js';
import { localityOf } from './regions.js';
import { assignPlaces, hubsFromSettings } from './places.js';
import { cachedGeocode } from './geocode.js';
import { blendPhotoScore } from './enrich/schema.js';

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
  /**
   * What a local model made of the row, kept apart from the scraped values so
   * the refresh's own repair passes cannot fight it and switching the task off
   * restores exactly what was there before. Empty when it has not looked, or
   * when it declined to answer for that field. See enrich/pipeline.ts.
   */
  llm_description: string;
  llm_category: string;
  llm_venue_name: string;
  llm_address: string;
  llm_price_text: string;
  llm_photo_score: number | null;
  /** What a vision model read off the flyer. See enrich/vision.ts. */
  vision_venue_name: string;
  vision_address: string;
  vision_price_text: string;
  vision_note: string;
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
}

/** Which pass supplied a field: the text model, or the one reading the flyer. */
export type EnrichedBy = 'model' | 'flyer';

/**
 * The key an event row groups under.
 *
 * A manual merge wins over the automatic one: the deduper reruns on every
 * refresh and would otherwise pull a hand-merged pair back apart.
 */
function groupKey(row: EventRow): string {
  return row.manual_group || row.dedupe_group || `solo-${row.id}`;
}

/** The first member that has anything to say, falling back to the first row. */
function firstNonEmpty(members: EventRow[], get: (r: EventRow) => string): string {
  for (const m of members) {
    const v = get(m);
    if (v && v.length) return v;
  }
  return get(members[0]);
}

/** What `chooseFields` settled on, and which of it came from a model. */
export interface ChosenFields {
  description: string;
  venueName: string;
  address: string;
  category: string;
  priceText: string;
  photoScore: number;
  note: string;
  enriched: Record<string, EnrichedBy>;
}

/**
 * Choose between the scraped value, the flyer and the text model, field by
 * field, and record which one won.
 *
 * The only place the three are weighed against each other, which is what keeps
 * enrichment from being load-bearing: with the tasks off, or before they have
 * run, every field here falls straight through to what was scraped.
 *
 * Pure, and separate from the merge around it, because this is the part worth
 * being sure about — and being sure needs nothing but rows.
 */
export function chooseFields(members: EventRow[]): ChosenFields {
  const str = (get: (r: EventRow) => string) => firstNonEmpty(members, get);

  /**
   * Every choice below records itself here when a model's answer is what won,
   * so the API can say so and a reader is never shown a machine's sentence as
   * though the organiser had written it.
   */
  const enriched: Record<string, EnrichedBy> = {};

  /**
   * The model's answer instead of the scraped one.
   *
   * For the two fields where replacing is the entire point: a rewritten blurb
   * is meant to supplant the CMS soup it was made from, and a category is meant
   * to supplant the keyword classifier's guess.
   */
  const preferLlm = (
    field: string, llm: (r: EventRow) => string, scraped: () => string
  ): string => {
    const written = str(llm);
    if (written) {
      enriched[field] = 'model';
      return written;
    }
    return scraped();
  };

  /**
   * The model's answer only where there was nothing.
   *
   * Venue, address and price are facts the source stated, not opinions to be
   * improved on, and a model asked to look at one will find something to say
   * about it: given a listing whose venue was "Nelsonville, Ohio" and whose
   * address was "International", qwen3 decided they were the wrong way round
   * and swapped them. Both were then wrong. Asking it to leave populated fields
   * alone helps; not consulting it about them cannot fail.
   */
  const fillBlank = (
    field: string,
    scraped: (r: EventRow) => string,
    ...guesses: [EnrichedBy, (r: EventRow) => string][]
  ): string => {
    const stated = str(scraped);
    if (stated) return stated;
    for (const [by, guess] of guesses) {
      const value = str(guess);
      if (value) {
        enriched[field] = by;
        return value;
      }
    }
    return '';
  };

  // A tidied blurb is preferred over the longest raw one: length was only ever
  // a stand-in for "most complete", and a rewritten one beats it.
  const longest = members.reduce((best, m) => (m.description.length > best.length ? m.description : best), '');
  const note = str((r) => r.vision_note);
  if (note) enriched.note = 'flyer';

  // Marked when a model had an opinion at all: unlike the fields above this is
  // a blend, so the number shown is part heuristic either way. See schema.ts —
  // the keyword score is deterministic and tuned on listings that have actually
  // turned up here, and the model has judgement about the ones it never sees.
  if (members.some((m) => m.llm_photo_score != null)) enriched.photoScore = 'model';

  return {
    description: preferLlm('description', (r) => r.llm_description, () => longest),
    venueName: fillBlank(
      'venueName', (r) => r.venue_name, ['flyer', (r) => r.vision_venue_name], ['model', (r) => r.llm_venue_name]
    ),
    address: fillBlank(
      'address', (r) => r.address, ['flyer', (r) => r.vision_address], ['model', (r) => r.llm_address]
    ),
    category: preferLlm('category', (r) => r.llm_category, () => str((r) => r.category)),
    priceText: fillBlank(
      'priceText', (r) => r.price_text, ['flyer', (r) => r.vision_price_text], ['model', (r) => r.llm_price_text]
    ),
    photoScore: Math.max(...members.map((m) => blendPhotoScore(m.photo_score, m.llm_photo_score))),
    note,
    enriched,
  };
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
    const str = (get: (r: EventRow) => string) => firstNonEmpty(members, get);
    const chosen = chooseFields(members);
    const { venueName, address, note, enriched } = chosen;
    // A merge is worth doing partly for this: a listing with no picture
    // inherits one from its twin. Distinct images are kept so nothing is lost.
    const images = [...new Set(members.map((m) => m.image_url).filter(Boolean))];

    merged.push({
      group,
      title: str((r) => r.title),
      description: chosen.description,
      // Not members[0]: rows arrive sorted by start, so a lone listing with a
      // date a day early would set the whole group's day. The date most
      // members agree on is the one to show.
      startTime: consensusStart(members.map((m) => m.start_time)),
      endTime: members.find((m) => m.end_time)?.end_time ?? null,
      venueName,
      address,
      // Derived here rather than in the browser: reading a locality out of an
      // address means knowing every country's postal tail, and that table
      // belongs in one place. See regions.ts. The venue field is tried too,
      // because a good few sources put the street address in it and leave the
      // address empty — those are exactly the rows that need a locality most,
      // since without one they head their own group by street number.
      locality: localityOf(address) || localityOf(venueName),
      // Filled in below, once every event is known: which town an event
      // rounds to depends on what the others taught about its suburb.
      place: '',
      lat: members.find((m) => m.lat != null)?.lat ?? null,
      lng: members.find((m) => m.lng != null)?.lng ?? null,
      imageUrl: images[0] ?? '',
      images,
      category: chosen.category,
      priceText: chosen.priceText,
      isOnline: members.every((m) => m.is_online === 1),
      photoScore: chosen.photoScore,
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
      note,
      enriched,
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
