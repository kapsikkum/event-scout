import { getKv, setKv } from './db.js';

const USER_AGENT = 'event-scout/0.1 (local personal app)';

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
}

const cacheKeyFor = (query: string): string => `geocode:${query.toLowerCase().trim()}`;

/** Has this query been looked up before? Callers use it to skip rate limiting. */
export function isGeocodeCached(query: string): boolean {
  return getKv(cacheKeyFor(query)) !== null;
}

export async function geocode(query: string): Promise<GeocodeResult[]> {
  const cacheKey = cacheKeyFor(query);
  const cached = getKv(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
  const data = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  const results = data.map((r) => ({
    displayName: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
  setKv(cacheKey, JSON.stringify(results));
  return results;
}
