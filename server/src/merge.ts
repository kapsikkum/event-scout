import { blendPhotoScore } from './enrich/schema.js';

/**
 * An event row, and how the three opinions about it are chosen between.
 *
 * Its own module because none of it touches a database, and the tests for it
 * should not open one. events.ts opens the database at import, so a test
 * reaching this through that file would race another test file's migrations
 * on a fresh one — which is how CI broke once already. The same split as
 * auth.ts against authStore.ts, for the same reason.
 */

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
  /**
   * What a person changed by hand. Beats all three of the above — someone who
   * has opened the listing and typed a venue in knows better than a scraper, a
   * flyer or a model. Empty means untouched, which is how clearing a field puts
   * the scraped value back. See db.ts.
   */
  edit_title: string;
  edit_description: string;
  edit_start_time: string;
  edit_venue_name: string;
  edit_address: string;
  edit_category: string;
  edit_price_text: string;
  edit_image_url: string;
  edit_photo_score: number | null;
}

/** The fields edit mode can override, as they are named on the wire. */
export const EDITABLE_FIELDS = [
  'title', 'description', 'startTime', 'venueName', 'address',
  'category', 'priceText', 'photoScore', 'imageUrl',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Which pass supplied a field: the text model, or the one reading the flyer. */
export type EnrichedBy = 'model' | 'flyer';

export class EditError extends Error {}

/** One normalised change: the field, and what to store for it. */
export interface ParsedEdit {
  field: EditableField;
  /** '' clears a text override; null clears the score. */
  value: string | number | null;
}

/**
 * Read an edit request into changes worth storing, or refuse it.
 *
 * Pure, and separate from the update it drives, because this is the half worth
 * being sure about: what counts as a date, what counts as a picture, and what
 * clears an override rather than setting it to nothing.
 */
export function parseEditPatch(patch: Record<string, unknown>): ParsedEdit[] {
  const out: ParsedEdit[] = [];

  for (const field of EDITABLE_FIELDS) {
    if (!(field in patch)) continue;
    const raw = patch[field];

    if (field === 'photoScore') {
      if (raw === null || raw === '') {
        out.push({ field, value: null });
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new EditError('photoScore must be a number from 0 to 100');
      out.push({ field, value: Math.round(n) });
      continue;
    }

    if (raw !== null && typeof raw !== 'string') throw new EditError(`${field} must be text`);
    let value = raw === null ? '' : raw.trim();

    if (field === 'startTime' && value) {
      // Stored as the same UTC instant as every other time, so sorting, the
      // past-grace window and the calendar feed keep working on it unchanged.
      const at = new Date(value);
      if (Number.isNaN(at.getTime())) throw new EditError('startTime is not a date');
      value = at.toISOString();
    }
    if (field === 'imageUrl' && value && !/^https?:\/\//i.test(value)) {
      throw new EditError('imageUrl must be an http:// or https:// address');
    }
    out.push({ field, value: value.slice(0, 2000) });
  }

  if (out.length === 0) throw new EditError('Nothing to change');
  return out;
}

/** The first member that has anything to say, falling back to the first row. */
export function firstNonEmpty(members: EventRow[], get: (r: EventRow) => string): string {
  for (const m of members) {
    const v = get(m);
    if (v && v.length) return v;
  }
  return get(members[0]);
}

/** What `chooseFields` settled on, and which of it came from a model. */
export interface ChosenFields {
  title: string;
  description: string;
  startTime: string;
  venueName: string;
  address: string;
  category: string;
  priceText: string;
  photoScore: number;
  /**
   * A picture chosen by hand, or null to use whatever the listings carry.
   *
   * Worth overriding more often than it looks: a listing's image is whatever
   * the organiser posted, which for the Bathurst 1000 is a series graphic
   * advertising two rounds at two different circuits.
   */
  imageUrl: string | null;
  /**
   * The blurb as the source published it, when that is not what is being shown.
   *
   * The rewrite is usually an improvement and sometimes a loss: asked to tidy
   * "Miss Traill's House - General Entry" the model produced two sentences
   * saying less than the listing did. Keeping the original means the page can
   * offer it back rather than the reader having to open the source to find out
   * what was dropped.
   */
  rawDescription: string;
  note: string;
  enriched: Record<string, EnrichedBy>;
  /**
   * The fields a person changed by hand, so the page can mark them and offer to
   * put back what was scraped. Separate from `enriched` rather than another
   * value in it: that says which machine wrote a field, and this says the
   * opposite — that no machine did.
   */
  edited: EditableField[];
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
   * A hand edit, if there is one, and a note that it happened.
   *
   * Checked before anything else for every field below: the whole point of edit
   * mode is that what you typed is what you see, whatever the scraper, the
   * flyer and the model have to say about it.
   */
  const edited: EditableField[] = [];
  const overridden = (field: EditableField, get: (r: EventRow) => string): string | null => {
    const value = str(get);
    if (!value) return null;
    edited.push(field);
    return value;
  };

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

  const editedScore = members.map((m) => m.edit_photo_score).find((v) => v != null);
  if (editedScore != null) edited.push('photoScore');

  const chosen: ChosenFields = {
    title: overridden('title', (r) => r.edit_title) ?? str((r) => r.title),
    description:
      overridden('description', (r) => r.edit_description) ??
      preferLlm('description', (r) => r.llm_description, () => longest),
    // Not chosen between three the way the rest are: the scraped time is the
    // only machine-readable one, and consensusStart in events.ts settles it
    // across members. An edit simply replaces the answer.
    startTime: overridden('startTime', (r) => r.edit_start_time) ?? '',
    venueName:
      overridden('venueName', (r) => r.edit_venue_name) ??
      fillBlank('venueName', (r) => r.venue_name, ['flyer', (r) => r.vision_venue_name], ['model', (r) => r.llm_venue_name]),
    address:
      overridden('address', (r) => r.edit_address) ??
      fillBlank('address', (r) => r.address, ['flyer', (r) => r.vision_address], ['model', (r) => r.llm_address]),
    category:
      overridden('category', (r) => r.edit_category) ??
      preferLlm('category', (r) => r.llm_category, () => str((r) => r.category)),
    priceText:
      overridden('priceText', (r) => r.edit_price_text) ??
      fillBlank('priceText', (r) => r.price_text, ['flyer', (r) => r.vision_price_text], ['model', (r) => r.llm_price_text]),
    photoScore:
      editedScore ?? Math.max(...members.map((m) => blendPhotoScore(m.photo_score, m.llm_photo_score))),
    imageUrl: overridden('imageUrl', (r) => r.edit_image_url),
    rawDescription: longest,
    note,
    enriched,
    edited,
  };

  // A field someone typed is not a field a model wrote, whatever the model may
  // also have had to say about it. Saying both would be a contradiction on the
  // card: an AI badge over a value the reader put there themselves.
  for (const field of edited) delete enriched[field];
  return chosen;
}
