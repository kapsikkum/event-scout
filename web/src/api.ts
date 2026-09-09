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
  /**
   * The town this rounds to, out of the ones being searched — a Llanarth
   * address arrives here as Bathurst. '' means nowhere near any of them.
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
  /** Every distinct image across the merged listings, best first. */
  images: string[];
  members: EventMember[];
  /** True when a person merged these, rather than the deduper. */
  manual: boolean;
  /** A line read off the flyer — when gates open, which entrance. '' when none. */
  note: string;
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
  midnightspecStates: string[];
  tasksDisabled: string[];
  llmEnabled: boolean;
  llmUrl: string;
  llmModel: string;
  llmJobs: string[];
  llmIntervalMinutes: number;
  llmMaxPerRun: number;
  visionEnabled: boolean;
  visionModel: string;
  visionIntervalMinutes: number;
  visionMaxPerRun: number;
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

/** What this build is. See server/src/version.ts. */
export interface VersionInfo {
  version: string;
  /** Short commit sha, '' when the build did not name one. */
  commit: string;
  builtAt: string;
  /** Ready to show: the number, with the commit appended off a release. */
  display: string;
}

/** What the local model can be asked to do, and how the pass is getting on. */
export interface LlmStatus {
  enabled: boolean;
  url: string;
  model: string;
  jobs: string[];
  reachable: boolean;
  /** Why not, when unreachable. */
  problem: string;
  models: { name: string; size: number }[];
  modelInstalled: boolean;
  /** Events still waiting to be read. */
  backlog: number;
  availableJobs: { key: string; label: string; hint: string }[];
  /** The flyer pass, which shares the server and the model list. */
  vision: { enabled: boolean; model: string; modelInstalled: boolean; backlog: number };
}

/** One background job, as the Tasks page shows it. */
export interface TaskStatus {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  /** False for jobs with no off switch, like venue discovery. */
  canDisable: boolean;
  /** True for jobs that only ever run when asked. */
  manualOnly: boolean;
  running: boolean;
  /** Set when something sharing this job's lock is running instead. */
  blockedBy: string | null;
  schedule: string | null;
  intervalMinutes: number | null;
  lastRun: string | null;
  lastResult: string | null;
  lastOk: boolean | null;
  nextDue: string | null;
  log: string[];
}

/** What a running refresh is doing and what it has turned up so far. */
export interface RefreshProgress {
  startedAt: string | null;
  /** Newest last. */
  lines: string[];
  found: number;
  /** Source name to what it is doing right now. */
  active: Record<string, string>;
}

export interface StatusResponse {
  sources: SourceStatus[];
  lastRefresh: string | null;
  refreshing: boolean;
  progress?: RefreshProgress;
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

export type Light = 'golden' | 'day' | 'blue' | 'night';

export interface ShootVerdict {
  score: number;
  label: 'Prime' | 'Good' | 'Fair' | 'Quiet' | 'Dead' | 'Unknown';
  why: string;
  light?: Light;
  surge?: boolean;
  estimated?: boolean;
}

export interface ObservedHour { avg: number; samples: number }

export interface DaySummary {
  readings: number;
  live: number;
  best: { from: number; to: number; score: number; label: string } | null;
}

export interface VenueHistory {
  name: string;
  lat: number;
  lon: number;
  points: HistoryPoint[];
  byDay: Record<string, Record<string, number>> | null;
  busiestDay: string | null;
  busiestHour: number | null;
  /** weekday (0 = Sunday) -> hour -> measured average. */
  observedByDay: Record<number, Record<number, ObservedHour>>;
  daySummary: Record<number, DaySummary>;
  lightByDay: Record<number, Record<number, Light>>;
  now: ShootVerdict | null;
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
  shoot: ShootVerdict;
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

/**
 * A request refused for want of a sign-in.
 *
 * Its own type because it is the one failure the UI answers rather than
 * reports: everything mutating funnels through here, so this is the single
 * place a login prompt needs to be triggered from.
 */
export class Unauthorized extends Error {
  constructor(message = 'Sign in to change this') {
    super(message);
    this.name = 'Unauthorized';
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new Unauthorized(message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface AuthStatus {
  /** Whether a password is configured at all. False means nothing is gated. */
  required: boolean;
  authed: boolean;
  /** Set from AUTH_PASSWORD, so it cannot be changed from the UI. */
  fromEnv: boolean;
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
  version: () => fetch('/api/version').then((r) => json<VersionInfo>(r)),
  authStatus: () => fetch('/api/auth/status').then((r) => json<AuthStatus>(r)),
  login: (password: string) =>
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then((r) => json<{ ok: boolean }>(r)),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),
  setPassword: (current: string, next: string) =>
    fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, next }),
    }).then((r) => json<{ ok: boolean; required: boolean }>(r)),
  feedToken: () => fetch('/api/auth/feed-token').then((r) => json<{ token: string }>(r)),
  regenerateFeedToken: () =>
    fetch('/api/auth/feed-token', { method: 'POST' }).then((r) => json<{ token: string }>(r)),
  llmStatus: () => fetch('/api/llm/status').then((r) => json<LlmStatus>(r)),
  llmReset: () => fetch('/api/llm/reset', { method: 'POST' }).then((r) => json<{ cleared: number }>(r)),
  visionReset: () => fetch('/api/vision/reset', { method: 'POST' }).then((r) => json<{ cleared: number }>(r)),
  tasks: () => fetch('/api/tasks').then((r) => json<{ tasks: TaskStatus[] }>(r)),
  // A refused run — already going, or sharing a busy browser — answers 409 with
  // a reason worth showing, so the body is read either way rather than thrown.
  runTask: (name: string, body: { holdSeconds?: number } = {}) =>
    fetch(`/api/tasks/${name}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<{ ok: boolean; message: string }>),
  enableTask: (name: string, enabled: boolean) =>
    fetch(`/api/tasks/${name}/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then((r) => r.json() as Promise<{ ok: boolean; message: string }>),
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
