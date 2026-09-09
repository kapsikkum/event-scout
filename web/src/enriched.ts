import type { MergedEvent } from './api';

/**
 * Saying which parts of an event a model wrote.
 *
 * The server keeps the scraped and the generated values in separate columns and
 * chooses between them, but by the time an event reaches a card the choice has
 * been made and a rewritten blurb reads exactly like the organiser's own words.
 * With the enrichment tasks on, most descriptions on the page are a model's
 * sentences — which is worth saying plainly rather than leaving to be found out.
 *
 * The wording lives here rather than in the components so the badge and the
 * footnote cannot drift apart.
 */

/** What each field is called when it is being pointed at, rather than shown. */
const FIELD_LABELS: Record<string, string> = {
  description: 'the description',
  category: 'the category',
  venueName: 'the venue',
  address: 'the address',
  priceText: 'the price',
  photoScore: 'the photo score',
  note: 'the note',
};

/** Listed in the order a reader meets them, not the order the object happens to hold. */
const FIELD_ORDER = ['description', 'category', 'venueName', 'address', 'priceText', 'note', 'photoScore'];

const SOURCE_LABELS = {
  model: 'Written by a local language model from the listing text',
  flyer: 'Read off the event flyer by a vision model',
} as const;

export interface EnrichedGroup {
  by: 'model' | 'flyer';
  /** What that pass supplied, e.g. "the description and the category". */
  fields: string;
  /** The sentence naming the pass. */
  label: string;
}

function joinFields(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** One entry per pass that contributed, or an empty array when none did. */
export function enrichedGroups(ev: MergedEvent): EnrichedGroup[] {
  const enriched = ev.enriched ?? {};
  const groups: EnrichedGroup[] = [];
  for (const by of ['model', 'flyer'] as const) {
    const fields = FIELD_ORDER.filter((f) => enriched[f] === by).map((f) => FIELD_LABELS[f] ?? f);
    if (fields.length) groups.push({ by, fields: joinFields(fields), label: SOURCE_LABELS[by] });
  }
  return groups;
}

export function isEnriched(ev: MergedEvent): boolean {
  return Object.keys(ev.enriched ?? {}).length > 0;
}

/** The whole thing as one line, for a badge's tooltip. */
export function enrichedTooltip(ev: MergedEvent): string {
  return enrichedGroups(ev)
    .map((g) => `${g.label}: ${g.fields}.`)
    .join(' ');
}
