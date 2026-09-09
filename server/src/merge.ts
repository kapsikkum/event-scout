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
}

/** Which pass supplied a field: the text model, or the one reading the flyer. */
export type EnrichedBy = 'model' | 'flyer';

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
