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
 * The sites searched as themselves.
 *
 * A search for "car show Bathurst" mostly finds websites, and the club that is
 * running the car show only ever posted it on Instagram. Asking the engine for
 * that site by name is what turns those posts up. Facebook is narrowed to its
 * events, since a Facebook page or post is nothing the app can read.
 */
export const SOCIAL_SEARCH_SITES = ['site:instagram.com', 'site:facebook.com/events'];

/** Of those, per area per cycle, on top of the rest. */
export const SOCIAL_QUERIES_PER_AREA = 2;

/** An hourly window over a list: the same list, a different handful each hour. */
function window<T>(list: T[], size: number, now: number): T[] {
  if (list.length <= size) return list;
  const start = (Math.floor(now / 3600_000) * size) % list.length;
  return Array.from({ length: size }, (_, i) => list[(start + i) % list.length]);
}

/**
 * This hour's search phrases for one area.
 *
 * A window over the whole list, moving every hour — the same trick the app's
 * web search uses. Five topics expand to thirty-odd phrases; firing all of them
 * every cycle gets the crawler rate-limited, and simply taking the first few,
 * which is what this did before, meant the rest never ran at all. Derived from
 * the clock so nothing has to be stored.
 *
 * With `social`, a couple more: the same terms, asked of Instagram and
 * Facebook by name. A term someone wrote with its own `site:` is left as they
 * wrote it and not given a second one.
 */
export function queriesFor(interest: Interest, limit = QUERIES_PER_AREA, now = Date.now(), social = false): string[] {
  const where = interest.city.trim();
  if (!where || limit <= 0) return [];
  const terms = [
    ...new Set(
      (interest.terms.length > 0 ? interest.terms : DEFAULT_TERMS).map((t) => t.trim()).filter(Boolean)
    ),
  ];
  const picked = window(terms.map((t) => `${t} ${where}`), limit, now);
  if (!social) return picked;

  const plain = terms.filter((t) => !/\bsite:/i.test(t));
  const combos = plain.flatMap((t) => SOCIAL_SEARCH_SITES.map((site) => `${t} ${where} ${site}`));
  return [...picked, ...window(combos, SOCIAL_QUERIES_PER_AREA, now)];
}
