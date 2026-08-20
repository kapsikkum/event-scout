export interface MergedEvent {
  group: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string | null;
  venueName: string;
  address: string;
  /** The suburb or town, worked out server-side. '' when the address names none. */
  locality: string;
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
  /** Every distinct image across the merged listings, best first. */
  images: string[];
  members: EventMember[];
  /** True when a person merged these, rather than the deduper. */
  manual: boolean;
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

export interface SourceStatus {
  name: string;
  label: string;
  unofficial: boolean;
  state: 'ok' | 'disabled' | 'missing_config' | 'error' | 'never_run';
  message: string;
  lastFetch: string | null;
  count: number;
}

export interface Settings {
  city: string;
  lat: number | null;
  lng: number | null;
  radiusKm: number;
  ticketmasterKey: string;
  seatgeekClientId: string;
  eventbriteToken: string;
  eventbriteOrganizerIds: string[];
  fbCookie: string;
  fbSearchTerms: string[];
  fbPages: string[];
  webSearchTerms: string[];
  eventTopics: string[];
  eventAreas: { name: string; lat?: number; lng?: number; radiusKm?: number }[];
  icalFeeds: { name: string; url: string }[];
  enabledSources: Record<string, boolean>;
  densityEnabled: boolean;
  densityIntervalMinutes: number;
  densityCities: string[];
  densityAreas: { name: string; lat?: number; lng?: number; radiusKm?: number }[];
  densitySearches: string[];
  densityPlaces: string[];
  densityMaxVenues: number;
}

export interface DensityStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastRun: string | null;
  lastResult: string | null;
  nextDue: string | null;
  areas: DensityArea[];
  log: string[];
}

export interface StatusResponse {
  sources: SourceStatus[];
  lastRefresh: string | null;
  refreshing: boolean;
}

export interface SunDay {
  date: string;
  sunrise: string | null;
  sunset: string | null;
  solarNoon: string | null;
  dayLength: string | null;
  goldenMorning: { start: string; end: string } | null;
  goldenEvening: { start: string; end: string } | null;
  blueMorning: { start: string; end: string } | null;
  blueEvening: { start: string; end: string } | null;
}

export interface WeatherDay {
  date: string;
  summary: string;
  tempMax: number | null;
  tempMin: number | null;
  cloudCover: number | null;
  rainChance: number | null;
  uvMax: number | null;
  windMax: number | null;
}

export interface MoonInfo { phase: string; illumination: number; age: number }

export interface PhotoConditions {
  location: { city: string; lat: number; lon: number } | null;
  today: { sun: SunDay; moon: MoonInfo; weather: WeatherDay | null };
  tomorrow: { sun: SunDay; moon: MoonInfo; weather: WeatherDay | null };
  now: { temp: number | null; cloudCover: number | null; summary: string; wind: number | null } | null;
  fetchedAt: string;
}

export interface HistoryPoint { ts: number; live: number | null; typical: number | null }

export interface VenueHistory {
  name: string;
  lat: number;
  lon: number;
  points: HistoryPoint[];
  byDay: Record<string, Record<string, number>> | null;
  busiestDay: string | null;
  busiestHour: number | null;
  observedByHour: Record<number, { avg: number; samples: number }>;
}

export interface EventTopic { key: string; label: string; terms: string[] }


export interface DensityArea {
  slug: string;
  name: string;
  venues: number;
  withProfile: number;
}

export interface VenueReading {
  name: string;
  lat: number;
  lon: number;
  live: number | null;
  typical: number | null;
  score: number;
  observedAt: string | null;
  busiestDay: string | null;
  busiestHour: number | null;
  quietestDay: string | null;
  openDays: string[] | null;
}

export interface DensityFeature {
  type: 'Feature';
  properties: { score: number; raw: number; colour: string; topName: string | null };
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
}

export interface DensityGeoJson {
  type: 'FeatureCollection';
  metadata: { label: string; area: string; observations: number; snapshots: number };
  features: DensityFeature[];
}

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  events: () => fetch('/api/events').then((r) => json<MergedEvent[]>(r)),
  status: () => fetch('/api/status').then((r) => json<StatusResponse>(r)),
  settings: () => fetch('/api/settings').then((r) => json<Settings>(r)),
  saveSettings: (s: Partial<Settings>) =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    }).then((r) => json<Settings>(r)),
  topics: () => fetch('/api/topics').then((r) => json<{ topics: EventTopic[] }>(r)),
  geocode: (q: string) => fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then((r) => json<GeocodeResult[]>(r)),
  refresh: () => fetch('/api/refresh', { method: 'POST' }).then((r) => json<StatusResponse>(r)),
  densityStatus: () => fetch('/api/density/status').then((r) => json<DensityStatus>(r)),
  densityRefresh: () =>
    fetch('/api/density/refresh', { method: 'POST' }).then((r) => json<{ ok: boolean; message: string }>(r)),
  densityDiscover: () =>
    fetch('/api/density/discover', { method: 'POST' }).then((r) => json<{ ok: boolean; message: string }>(r)),
  photo: () => fetch('/api/photo').then((r) => json<PhotoConditions>(r)),
  densityAreas: () => fetch('/api/density/areas').then((r) => json<{ areas: DensityArea[] }>(r)),
  density: (area: string, params = '') =>
    fetch(`/api/density/${area}${params}`).then((r) => json<DensityGeoJson>(r)),
  venueHistory: (area: string, venue: string, days = 14) =>
    fetch(`/api/density/${area}/history?venue=${encodeURIComponent(venue)}&days=${days}`)
      .then((r) => json<VenueHistory>(r)),
  venues: (area: string) => fetch(`/api/density/${area}/venues`).then((r) => json<VenueReading[]>(r)),
  merge: (groups: string[]) =>
    fetch('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups }),
    }).then((r) => json<{ group: string; merged: number }>(r)),
  unmerge: (group: string) =>
    fetch(`/api/unmerge/${group}`, { method: 'POST' }).then((r) => json<{ split: number }>(r)),
  setGroupFlag: (group: string, flags: { starred?: boolean; hidden?: boolean }) =>
    fetch(`/api/groups/${group}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flags),
    }).then((r) => json<{ ok: boolean }>(r)),
};

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
