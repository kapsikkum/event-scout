import type { MergedEvent } from './events.js';

/**
 * Asking for part of the list rather than all of it.
 *
 * `GET /api/events` answers with every upcoming event, which is what the web
 * app wants — it filters and sorts in the browser, and 690 events is a megabyte
 * it only fetches once. Anything else calling this has to download that
 * megabyte and pick through it to answer "what is on in Bathurst this weekend",
 * which is the question most callers actually have.
 *
 * Pure on purpose: parsing and filtering are the parts worth testing, and
 * neither needs a database to be wrong. The route in index.ts does the reading.
 */

/** Which way a bad request is reported, so every route says it the same way. */
export class QueryError extends Error {}

export interface EventQuery {
  archived: boolean;
  /** Free text across title, description, venue and address. */
  q?: string;
  category?: string[];
  locality?: string[];
  place?: string[];
  source?: string[];
  /** Inclusive bounds on the start time, as ISO dates or full timestamps. */
  from?: string;
  to?: string;
  starred?: boolean;
  hidden?: boolean;
  online?: boolean;
  minScore?: number;
  limit?: number;
  offset: number;
}

/** Every parameter this route understands, so a typo can be told from a filter. */
const KNOWN = new Set([
  'archived', 'q', 'category', 'locality', 'place', 'source',
  'from', 'to', 'starred', 'hidden', 'online', 'minScore', 'limit', 'offset',
]);

function one(value: unknown, name: string): string {
  // Express turns a repeated parameter into an array. Rather than silently
  // using the first, say so: a caller repeating ?category= probably meant the
  // comma-separated form and would otherwise be quietly given half an answer.
  if (Array.isArray(value)) throw new QueryError(`Repeat ${name}= as one comma-separated value`);
  return String(value);
}

function list(value: unknown, name: string): string[] | undefined {
  const parts = one(value, name).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function bool(value: unknown, name: string): boolean {
  const v = one(value, name).toLowerCase();
  if (['1', 'true', 'yes'].includes(v)) return true;
  if (['0', 'false', 'no'].includes(v)) return false;
  throw new QueryError(`${name}= must be true or false`);
}

function int(value: unknown, name: string, min: number): number {
  const n = Number(one(value, name));
  if (!Number.isInteger(n) || n < min) throw new QueryError(`${name}= must be a whole number ${min} or more`);
  return n;
}

/**
 * A date bound, accepted as a plain date as well as a full timestamp.
 *
 * `?from=2026-09-25` is what a person writes, and it has to mean the whole of
 * that day rather than midnight UTC on it — otherwise an event that morning
 * falls outside a range that plainly includes it.
 */
function date(value: unknown, name: string, endOfDay: boolean): string {
  const raw = one(value, name).trim();
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const at = new Date(dayOnly ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : raw);
  if (Number.isNaN(at.getTime())) throw new QueryError(`${name}= is not a date`);
  return at.toISOString();
}

/** Read a query string into a filter, refusing anything it does not understand. */
export function parseEventQuery(query: Record<string, unknown>): EventQuery {
  for (const key of Object.keys(query)) {
    // A silently ignored filter is the worst outcome here: the caller gets a
    // complete list and no reason to doubt it.
    if (!KNOWN.has(key)) {
      throw new QueryError(`Unknown parameter: ${key}. Known: ${[...KNOWN].sort().join(', ')}`);
    }
  }

  const has = (k: string) => query[k] !== undefined && query[k] !== '';
  const out: EventQuery = {
    archived: has('archived') ? bool(query.archived, 'archived') : false,
    offset: has('offset') ? int(query.offset, 'offset', 0) : 0,
  };

  if (has('q')) out.q = one(query.q, 'q').trim().toLowerCase();
  if (has('category')) out.category = list(query.category, 'category');
  if (has('locality')) out.locality = list(query.locality, 'locality');
  if (has('place')) out.place = list(query.place, 'place');
  if (has('source')) out.source = list(query.source, 'source');
  if (has('from')) out.from = date(query.from, 'from', false);
  if (has('to')) out.to = date(query.to, 'to', true);
  if (has('starred')) out.starred = bool(query.starred, 'starred');
  if (has('hidden')) out.hidden = bool(query.hidden, 'hidden');
  if (has('online')) out.online = bool(query.online, 'online');
  if (has('minScore')) out.minScore = int(query.minScore, 'minScore', 0);
  if (has('limit')) out.limit = int(query.limit, 'limit', 1);

  if (out.from && out.to && out.from > out.to) throw new QueryError('from= is after to=');
  return out;
}

/** Case-insensitive membership, so ?category=festivals matches "Festivals". */
function matches(wanted: string[] | undefined, value: string): boolean {
  if (!wanted) return true;
  return wanted.some((w) => w.toLowerCase() === value.toLowerCase());
}

/**
 * Narrow the merged list. Order is left as it was — the caller sorted already,
 * and paging through a list that reorders itself skips events.
 */
export function filterEvents(events: MergedEvent[], q: EventQuery): MergedEvent[] {
  return events.filter((ev) => {
    if (!matches(q.category, ev.category)) return false;
    if (!matches(q.locality, ev.locality)) return false;
    if (!matches(q.place, ev.place)) return false;
    if (q.source && !ev.sources.some((s) => matches(q.source, s.source))) return false;
    if (q.from && ev.startTime < q.from) return false;
    if (q.to && ev.startTime > q.to) return false;
    if (q.starred !== undefined && ev.starred !== q.starred) return false;
    if (q.hidden !== undefined && ev.hidden !== q.hidden) return false;
    if (q.online !== undefined && ev.isOnline !== q.online) return false;
    if (q.minScore !== undefined && ev.photoScore < q.minScore) return false;
    if (q.q) {
      const hay = [ev.title, ev.description, ev.venueName, ev.address].join(' ').toLowerCase();
      if (!hay.includes(q.q)) return false;
    }
    return true;
  });
}

/** One page of the filtered list, plus the total it was taken from. */
export function paginate<T>(items: T[], q: EventQuery): { page: T[]; total: number } {
  const page = q.limit === undefined && q.offset === 0
    ? items
    : items.slice(q.offset, q.limit === undefined ? undefined : q.offset + q.limit);
  return { page, total: items.length };
}
