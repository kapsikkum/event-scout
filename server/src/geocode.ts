import { getKv, setKv } from './db.js';

const USER_AGENT = 'event-scout/0.1 (local personal app)';

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
  /**
   * What the geocoder says this is — "place:town", "amenity:pub" — or absent
   * for an answer cached before this was kept. Only a populated place can
   * anchor a listing; see locate.ts.
   */
  kind?: string;
}

/** A cached answer, with when it was asked for. */
interface CacheEntry {
  at: number;
  results: GeocodeResult[];
}

/**
 * How long a cached answer is trusted before it is asked for again.
 *
 * An empty answer expires fast: a query that turns up nothing today is
 * usually a venue that hasn't been added to the map yet, and it would be
 * wrong to keep saying so forever. A real answer barely moves, so it is kept
 * for months rather than asking Nominatim about the same town every refresh.
 */
const EMPTY_TTL_MS = 7 * 24 * 3600_000;
const RESULT_TTL_MS = 180 * 24 * 3600_000;

const cacheKeyFor = (query: string): string => `geocode:${query.toLowerCase().trim()}`;

/**
 * The parsed cache entry, or null when there is none or it predates `kind`
 * being kept (the old format was a bare array) — those are read back as
 * stale rather than trusted, since a wrong verdict from before `kind` existed
 * (isPlace, pickAnchor) is worth asking again for.
 */
function readEntry(query: string): CacheEntry | null {
  const raw = getKv(cacheKeyFor(query));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as CacheEntry | GeocodeResult[];
  if (Array.isArray(parsed)) return null;
  if (parsed.results.some((r) => !r.kind)) return null;
  return parsed;
}

function isFresh(entry: CacheEntry): boolean {
  const ttl = entry.results.length === 0 ? EMPTY_TTL_MS : RESULT_TTL_MS;
  return Date.now() - entry.at < ttl;
}

/** Has this query got a fresh cached answer? Callers use it to skip rate limiting. */
export function isGeocodeCached(query: string): boolean {
  const entry = readEntry(query);
  return entry !== null && isFresh(entry);
}

/**
 * The cached answer for a query, without going near the network — stale or
 * not, since a page load has no way to refetch it anyway.
 *
 * Everything that geocodes runs inside a refresh, which is asynchronous and
 * rate-limited. Placing an event against the towns the user searches happens
 * on every read of the event list instead, which is neither — so it reads what
 * earlier refreshes already looked up and does without an answer when there
 * isn't one, rather than turning a page load into a Nominatim request.
 */
export function cachedGeocode(query: string): GeocodeResult[] | null {
  const raw = getKv(cacheKeyFor(query));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as CacheEntry | GeocodeResult[];
  return Array.isArray(parsed) ? parsed : parsed.results;
}

/**
 * Nominatim's one-request-a-second rule, enforced once for the whole process
 * rather than by each caller.
 *
 * refresh.ts and addManualEvent used to each sleep between their own calls,
 * which spaces out one caller's requests but not two callers' at once — a
 * manual add during a refresh could still land two requests in the same
 * second. A single chain of promises serialises every uncached call through
 * here instead, wherever it came from.
 * ponytail: a process-wide lock, not per-key — fine at Nominatim's own limit
 * of one request a second total, not one per query.
 */
let nominatimQueue: Promise<void> = Promise.resolve();
function throttle(): Promise<void> {
  const wait = nominatimQueue.then(() => new Promise<void>((resolve) => setTimeout(resolve, 1100)));
  nominatimQueue = wait;
  return wait;
}

export async function geocode(query: string): Promise<GeocodeResult[]> {
  const cacheKey = cacheKeyFor(query);
  const entry = readEntry(query);
  if (entry && isFresh(entry)) return entry.results;

  await throttle();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
  const data = (await res.json()) as
    { display_name: string; lat: string; lon: string; class?: string; type?: string }[];
  const results = data.map((r) => ({
    displayName: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    kind: `${r.class ?? ''}:${r.type ?? ''}`,
  }));
  setKv(cacheKey, JSON.stringify({ at: Date.now(), results }));
  return results;
}
