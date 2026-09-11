/**
 * What to type into a search engine, for one area.
 *
 * Pure, so the rotation can be tested without a network or a database.
 */

/** An area event-scout wants covered, and the terms worth searching in it. */
export interface Interest {
  city: string;
  /** Bare terms — "car show", "markets" — which the place is appended to. */
  terms: string[];
}

/**
 * Used when an area arrives with no terms of its own: no topics chosen and no
 * extra search terms. Broad on purpose; narrower is what topics are for.
 */
export const DEFAULT_TERMS = [
  'events', "what's on", 'festival', 'markets', 'live music',
  'car show', 'agricultural show', 'motorsport',
];

/** Phrases one area may spend per cycle, before search engines start to mind. */
export const QUERIES_PER_AREA = 8;

/**
 * This hour's search phrases for one area.
 *
 * A window over the whole list, moving every hour — the same trick the app's
 * web search uses. Five topics expand to thirty-odd phrases; firing all of them
 * every cycle gets the crawler rate-limited, and simply taking the first few,
 * which is what this did before, meant the rest never ran at all. Derived from
 * the clock so nothing has to be stored.
 */
export function queriesFor(interest: Interest, limit = QUERIES_PER_AREA, now = Date.now()): string[] {
  const where = interest.city.trim();
  if (!where || limit <= 0) return [];
  const terms = [
    ...new Set(
      (interest.terms.length > 0 ? interest.terms : DEFAULT_TERMS).map((t) => t.trim()).filter(Boolean)
    ),
  ];
  const phrases = terms.map((t) => `${t} ${where}`);
  if (phrases.length <= limit) return phrases;
  const start = (Math.floor(now / 3600_000) * limit) % phrases.length;
  return Array.from({ length: limit }, (_, i) => phrases[(start + i) % phrases.length]);
}
