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
  /** The start is a day with no clock time; show the day alone. */
  dateOnly: boolean;
  photoScore: number;
  starred: boolean;
  hidden: boolean;
  /**
   * When the first of its listings was found. null when one of them predates
   * the app keeping track, which is never "recent".
   */
  firstSeenAt: string | null;
  /** Nothing says where it is: no coordinates, venue, address or town. */
  unknownLocation: boolean;
  /** Why it is out of sight on its own (outside every area, excluded category), or null. */
  culled: string | null;
  sources: { source: string; url: string }[];
  /** Every distinct image across the merged listings, best first. */
  images: string[];
  members: EventMember[];
  /** True when a person merged these, rather than the deduper. */
  manual: boolean;
  /**
   * The repeating series this is one date of — same name, same place. The
   * Events page folds a series into one card; the calendar keeps every date.
   */
  series: string;
  /** A line read off the flyer — when gates open, which entrance. '' when none. */
  note: string;
  /**
   * Which fields above are a model's answer rather than the source's own words.
   * `model` is the text pass, `flyer` the one that reads the promotional image.
   * Absent fields are as published. Empty whenever the tasks have not run.
   */
  enriched: Record<string, 'model' | 'flyer'>;
  /**
   * Fields changed by hand in edit mode. These beat the scraped value, the
   * flyer and the model alike; clearing one puts back what would have shown.
   */
  edited: string[];
  /**
   * The blurb as published, when what is shown is not it. '' when they match.
   * The detail view offers it behind the mark beside the paragraph.
   */
  rawDescription: string;
}

/** What edit mode may change. Send '' or null to drop an override. */
export interface EventEdit {
  title?: string | null;
  description?: string | null;
  startTime?: string | null;
  venueName?: string | null;
  address?: string | null;
  category?: string | null;
  priceText?: string | null;
  imageUrl?: string | null;
  photoScore?: number | null;
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
  ticketmasterKey: string | null;
  seatgeekClientId: string | null;
  eventbriteToken: string | null;
  eventbriteOrganizerIds: string[];
  /**
   * Credentials are never sent back — these arrive as '' whatever is stored,
   * and `secretsSet` says which exist. Sending '' back leaves the stored value
   * alone, which is what makes saving the whole settings object safe; `null`
   * is how one is cleared on purpose.
   */
  fbCookie: string | null;
  fbSearchTerms: string[];
  fbPages: string[];
  webSearchTerms: string[];
  eventTopics: string[];
  eventAreas: { name: string; lat?: number; lng?: number; radiusKm?: number }[];
  /** Keep events well outside every area out of sight. Never deletes; undoes itself. */
  cullOutsideAreas: boolean;
  /** Categories kept out of sight. */
  excludedCategories: string[];
  icalFeeds: { name: string; url: string }[];
  midnightspecStates: string[];
  tasksDisabled: string[];
  /** Which credentials are stored. Read-only; sending it back changes nothing. */
  secretsSet?: Record<'ticketmasterKey' | 'seatgeekClientId' | 'eventbriteToken' | 'fbCookie' | 'matrixAccessToken', boolean>;
  /**
   * Origins allowed to read the API from a page served elsewhere. Empty means
   * none, which is what a browser does by default. "*" means any. Only ever
   * grants the open reads — never a write, never this settings object.
   */
  corsOrigins: string[];
  llmEnabled: boolean;
  crawlerUrl: string;
  crawlerUrls: string[];
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
  /** Discord webhooks and Matrix rooms to tell about events. */
  notifyTargets: NotifyTarget[];
  matrixBot: { enabled: boolean; homeserver: string; commandPrefix: string; allowedUsers: string[] };
  /** Arrives as ''; see secretsSet. */
  matrixAccessToken: string | null;
  /** This app's address as notification readers reach it, for "Open in Event Scout". */
  appUrl: string;
}

export interface NotifyFilters {
  /** Town names, or 'unknown' for events with no place. */
  places: string[];
  categories: string[];
  excludeCategories: string[];
  minPhotoScore: number;
  keywords: string[];
  excludeKeywords: string[];
  starredOnly: boolean;
}

export interface NotifyTarget {
  id: string;
  kind: 'discord' | 'matrix';
  name: string;
  enabled: boolean;
  /** Arrives as '', with webhookSet saying whether one is stored. '' keeps it, null clears it. */
  webhookUrl: string | null;
  webhookSet?: boolean;
  username: string;
  avatarUrl: string;
  mention: string;
  style: 'full' | 'compact';
  showImage: boolean;
  roomId: string;
  triggers: {
    newEvents: { enabled: boolean; settleMinutes: number; maxPerRun: number };
    digest: { enabled: boolean; cadence: 'daily' | 'weekly'; weekday: number; hour: number; daysAhead: number };
    reminders: { enabled: boolean; hoursBefore: number[] };
    starredChanges: { enabled: boolean };
  };
  filters: NotifyFilters;
  quietHours: { enabled: boolean; from: number; to: number };
}

export interface NotifyStatus {
  matrix: {
    state: 'off' | 'starting' | 'running' | 'error';
    userId: string;
    rooms: number;
    lastError: string;
    lastSyncAt: string | null;
    /** Invites turned down because the inviter is not on the allowed list. */
    ignoredInvites?: { roomId: string; from: string; at: string }[];
  };
  targets: Record<string, { at: string; ok: boolean; message: string } | null>;
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
  /** Events already read, so a reset can say what it is throwing away. */
  read: number;
  availableJobs: { key: string; label: string; hint: string }[];
  /** The flyer pass, which shares the server and the model list. */
  vision: { enabled: boolean; model: string; modelInstalled: boolean; backlog: number; read: number };
}

/** One line in the tasks console. */
export interface LogEntry {
  seq: number;
  at: string;
  task: string;
  kind: 'start' | 'log' | 'end';
  line: string;
  failed?: boolean;
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

/** What the crawler says about itself, passed through by the server. */
export interface CrawlerCycle {
  startedAt: string;
  finishedAt: string | null;
  seeded: number;
  fetched: number;
  failed: number;
  blocked: number;
  events: number;
  feeds: number;
  lines: string[];
}

/** One finished cycle, with the queue and the finds as they stood at its end. */
export interface CrawlerHistoryRow {
  startedAt: string;
  finishedAt: string;
  fetched: number;
  events: number;
  failed: number;
  blocked: number;
  seeded: number;
  feeds: number;
  queued: number;
  finds: number;
}

/** What is in a calendar feed, read without adding it. */
export interface IcalPreview {
  ok: boolean;
  url: string;
  message?: string;
  calendarName?: string;
  /** Every event in the file. */
  total?: number;
  /** The ones the source would keep: from yesterday to six months out. */
  upcoming?: number;
  /** The first hundred of those, soonest first. */
  events?: { title: string; startTime: string; dateOnly: boolean; where: string; url: string }[];
}

export interface CrawlerStatus {
  reachable: boolean;
  /** The last day or so of finished cycles, oldest first. */
  history?: CrawlerHistoryRow[];
  /** Instagram read, and Facebook events noted for the app to read. */
  social?: {
    enabled: boolean;
    instagramProfiles: number;
    instagramPostsRead: number;
    instagramEvents: number;
    facebookEvents: number;
  };
  url?: string;
  problem?: string;
  enabled?: boolean;
  running?: boolean;
  current?: CrawlerCycle | null;
  last?: CrawlerCycle | null;
  pages?: Record<string, number>;
  finds?: number;
  feeds?: number;
  /** Each area, how many phrases it has, and the ones being searched this hour. */
  interests?: { city: string; terms: number; thisCycle: string[] }[];
  /** Pages it reads every six hours whatever the searches find. */
  seeds?: string[];
  config?: {
    maxPagesPerRun: number;
    maxDepth: number;
    concurrency: number;
    minHostDelayMs: number;
    intervalMinutes: number;
    userAgent: string;
  };
  feedList?: { url: string; site: string; foundOn: string }[];
}

/** What reading one page turned up. */
export interface CrawlPageReport {
  url: string;
  finalUrl?: string;
  ok: boolean;
  message: string;
  events: { title: string; startTime: string; dateOnly?: boolean; venueName?: string; url?: string }[];
  links: number;
  feeds: string[];
  /** Times the crawler has read this page, this time included. */
  reads?: number;
}

/** A page the crawler has read, and how often. */
export interface CrawlerPageRow {
  url: string;
  site: string;
  state: string;
  reads: number;
  events: number;
  fetchedAt: string | null;
  note: string;
}

/** Which reader filled a field of an imported event. */
export type FoundBy = 'json-ld' | 'facebook' | 'instagram' | 'page' | 'text' | 'model';

/** One event read off a page by "Add from a link", for checking before it is saved. */
export interface ImportCandidate {
  title: string;
  description: string;
  /** '' when the page gave no date. */
  startTime: string;
  dateOnly: boolean;
  endTime: string;
  venueName: string;
  address: string;
  lat: number | null;
  lng: number | null;
  url: string;
  imageUrl: string;
  priceText: string;
  found: Partial<Record<'title' | 'description' | 'startTime' | 'endTime' | 'venueName' | 'address' | 'imageUrl', FoundBy>>;
}

export interface ImportPreview {
  ok: boolean;
  url: string;
  message: string;
  candidates: ImportCandidate[];
}

/** What the form sends back to be saved. */
export interface ImportEvent {
  url: string;
  title: string;
  description: string;
  startTime: string;
  dateOnly: boolean;
  endTime: string;
  venueName: string;
  address: string;
  imageUrl: string;
  priceText: string;
  category: string;
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
  editEvent: (group: string, patch: EventEdit) =>
    fetch(`/api/events/${encodeURIComponent(group)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<{ updated: string[]; event: MergedEvent }>(r)),
  status: () => fetch('/api/status').then((r) => json<StatusResponse>(r)),
  settings: () => fetch('/api/settings').then((r) => json<Settings>(r)),
  saveSettings: (s: Partial<Settings>) =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    }).then((r) => json<Settings>(r)),
  topics: () => fetch('/api/topics').then((r) => json<{ topics: EventTopic[]; categories?: string[] }>(r)),
  geocode: (q: string) => fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then((r) => json<GeocodeResult[]>(r)),
  refresh: () => fetch('/api/refresh', { method: 'POST' }).then((r) => json<StatusResponse>(r)),
  version: () => fetch('/api/version').then((r) => json<VersionInfo>(r)),
  crawlerStatus: () => fetch('/api/crawler/status').then((r) => json<CrawlerStatus>(r)),
  crawlerPages: (sort: 'reads' | 'recent') =>
    fetch(`/api/crawler/pages?sort=${sort}`).then((r) => json<{ pages: CrawlerPageRow[]; problem?: string }>(r)),
  crawlerRun: () =>
    fetch('/api/crawler/run', { method: 'POST' }).then((r) => json<{ ok: boolean; message?: string }>(r)),
  crawlerCrawl: (url: string) =>
    fetch('/api/crawler/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(async (r) => {
      // The body is read whatever the status: a refusal carries its reason,
      // and json() would reduce it to "HTTP 400".
      if (r.status === 401) throw new Unauthorized();
      const body = (await r.json().catch(() => ({}))) as Partial<CrawlPageReport>;
      return { url, ok: false, message: `HTTP ${r.status}`, events: [], links: 0, feeds: [], ...body } as CrawlPageReport;
    }),
  icalPreview: (url: string) =>
    fetch('/api/ical/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(async (r) => {
      // As above: a refusal carries its reason in the body.
      if (r.status === 401) throw new Unauthorized();
      const body = (await r.json().catch(() => ({}))) as Partial<IcalPreview>;
      return { url, ok: false, message: `HTTP ${r.status}`, ...body } as IcalPreview;
    }),
  importPreview: (url: string) =>
    fetch('/api/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then(async (r) => {
      // A refusal carries its reason in the body, as with the feed preview.
      if (r.status === 401) throw new Unauthorized();
      const body = (await r.json().catch(() => ({}))) as Partial<ImportPreview>;
      return { url, ok: false, message: `HTTP ${r.status}`, candidates: [], ...body } as ImportPreview;
    }),
  importEvent: (ev: ImportEvent) =>
    fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    }).then((r) => json<{ group: string; event: MergedEvent | null }>(r)),
  notifyStatus: () => fetch('/api/notify/status').then((r) => json<NotifyStatus>(r)),
  notifyTest: (id: string) =>
    fetch('/api/notify/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then((r) => json<{ ok: boolean; message: string }>(r)),
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
  apiToken: () => fetch('/api/auth/token').then((r) => json<{ token: string }>(r)),
  regenerateApiToken: () =>
    fetch('/api/auth/token', { method: 'POST' }).then((r) => json<{ token: string }>(r)),
  revokeApiToken: () =>
    fetch('/api/auth/token', { method: 'DELETE' }).then((r) => json<{ token: string }>(r)),
  llmStatus: () => fetch('/api/llm/status').then((r) => json<LlmStatus>(r)),
  llmReset: () => fetch('/api/llm/reset', { method: 'POST' }).then((r) => json<{ cleared: number }>(r)),
  visionReset: () => fetch('/api/vision/reset', { method: 'POST' }).then((r) => json<{ cleared: number }>(r)),
  // `since` is the highest sequence number already held, so a poll carries only
  // what is new. Zero asks for everything the server still remembers.
  tasks: (since = 0) =>
    fetch(`/api/tasks?since=${since}`).then((r) =>
      json<{ tasks: TaskStatus[]; log: LogEntry[]; seq: number }>(r)
    ),
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
