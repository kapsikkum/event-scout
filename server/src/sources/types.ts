export interface Location {
  lat: number;
  lng: number;
  radiusKm: number;
  city: string;
  /**
   * How many search queries this area may spend. Set when several areas are
   * configured, so the total across a refresh stays inside what the search
   * engines will tolerate. Absent means "use the source's own default".
   */
  queryBudget?: number;
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
  /**
   * Preset topics, expanded into search phrases per area. See `topics.ts`.
   * Custom terms above still apply and are appended to whatever these produce.
   */
  eventTopics: string[];
  /**
   * Extra places to look for events, beyond the city above. Every source runs
   * once per area, so a two-hour drive worth going on can be watched without
   * widening the home radius and dragging in everything between.
   */
  eventAreas: EventArea[];
  /**
   * Keep events well outside every area above out of sight. Worked out when
   * the list is read, never stored, so it undoes itself when an area is added
   * back; events with no place at all are never taken. See cull.ts.
   */
  cullOutsideAreas: boolean;
  /** Categories to keep out of sight, by name. Same rules as the above. */
  excludedCategories: string[];
  icalFeeds: { name: string; url: string }[];
  /**
   * States to read from the MIDNIGHT_SPEC car-meet feed, lowercase and
   * abbreviated ('nsw', 'vic', …). Empty means all of them; naming the ones
   * near you saves a request each and nothing else, since listings are filtered
   * on locality regardless.
   */
  midnightspecStates: string[];
  /**
   * Background jobs paused from the Tasks page, by name. Only for the ones with
   * no setting of their own — density and enrichment are governed by the
   * settings that already exist for them, so there is one answer rather than two.
   */
  tasksDisabled: string[];
  /**
   * Origins allowed to read the API from a page served elsewhere, e.g.
   * "https://dash.example.com". Empty means none, which is a browser's default
   * and what this behaved like before the setting existed. "*" means any.
   *
   * Only ever grants the reads that are already open to anyone who can reach
   * the port — never a write, never the settings. See cors.ts.
   */
  corsOrigins: string[];
  /**
   * Where the crawler is listening, e.g. "http://crawler:3002".
   *
   * A separate program, running beside this one and asked rather than trusted:
   * it holds no credential for this app and writes nothing here. Blank falls
   * back to `CRAWLER_URL`, which docker-compose sets; blank with no variable
   * means the source reports missing config and is skipped.
   */
  crawlerUrl: string;
  /**
   * Pages the crawler should read whatever its searches turn up — a venue's
   * what's-on, a council calendar — every six hours, along with the pages they
   * link to. Handed over whenever settings are saved, so an addition is picked
   * up on its next cycle rather than after the next refresh.
   */
  crawlerUrls: string[];
  /**
   * Read scraped listings with a local model, as a background task. Off by
   * default, and nothing depends on it: every verdict is stored beside the
   * scraped value rather than over it.
   */
  llmEnabled: boolean;
  /**
   * An Ollama. Blank uses `OLLAMA_URL`, then `http://localhost:11434`. In
   * Docker the host's is `http://host.docker.internal:11434` — localhost inside
   * a container is the container.
   */
  llmUrl: string;
  llmModel: string;
  /** Which of 'describe' | 'classify' | 'extract' | 'score' to ask for. */
  llmJobs: string[];
  llmIntervalMinutes: number;
  /** Events per pass. A backlog drains over several runs rather than one long one. */
  llmMaxPerRun: number;
  /**
   * Read event flyers with a vision model, filling venue, address and price
   * where the listing left them blank. Its own model and schedule: a flyer
   * costs four times what a description does, and the models that can read one
   * are not the models that write well.
   */
  visionEnabled: boolean;
  visionModel: string;
  visionIntervalMinutes: number;
  visionMaxPerRun: number;
  enabledSources: Record<string, boolean>;
  /** Scrape venue density on a timer, alongside the event sources. */
  densityEnabled: boolean;
  /** How often to sample busyness. Meaningful data needs 30-60 minutes. */
  densityIntervalMinutes: number;
  /** Areas to map. Empty falls back to the configured city above. */
  densityAreas: DensityArea[];
  /** Restrict a run to these areas by name or slug; empty means all of them. */
  densityCities: string[];
  /** Google Maps search terms used to find venues. Empty uses the defaults. */
  densitySearches: string[];
  /** Venues pinned by name, for places no category term reliably surfaces. */
  densityPlaces: string[];
  /**
   * Cap on venues polled per area. 0 means no cap — every place discovery
   * finds. Each venue costs one page load, so the cap is a time budget rather
   * than a technical limit.
   */
  densityMaxVenues: number;
  densityCellMeters: number;
  densityKernelMeters: number;
  densityBrowserPath: string;
  /**
   * Where to tell people about events: Discord webhooks and Matrix rooms, each
   * with its own triggers and filters. See notify/.
   */
  notifyTargets: NotifyTarget[];
  /** The Matrix account that posts to the rooms above and answers commands in them. */
  matrixBot: MatrixBotSettings;
  /** That account's access token. A credential: never sent back. */
  matrixAccessToken: string;
  /**
   * This app's own address as the people reading a notification reach it,
   * e.g. "https://events.example.com". Blank leaves the "open in Event Scout"
   * link off; the listing's own link is always there.
   */
  appUrl: string;
}

/** What a notification target lets through. An empty list means any. */
export interface NotifyFilters {
  /** Towns, as the location filter names them; 'unknown' for events with no place. */
  places: string[];
  categories: string[];
  excludeCategories: string[];
  /** 0 lets everything through. */
  minPhotoScore: number;
  /** Any one of these in the title, description or venue. */
  keywords: string[];
  excludeKeywords: string[];
  starredOnly: boolean;
}

export interface NotifyTriggers {
  /** Events first found since the last run, once they have had time to settle. */
  newEvents: { enabled: boolean; settleMinutes: number; maxPerRun: number };
  /** What is coming up, at a set hour, every day or on one day a week. */
  digest: { enabled: boolean; cadence: 'daily' | 'weekly'; weekday: number; hour: number; daysAhead: number };
  /** Before each starred event starts, this many hours ahead. */
  reminders: { enabled: boolean; hoursBefore: number[] };
  /** A starred event's time, place or name changing. */
  starredChanges: { enabled: boolean };
}

export interface NotifyTarget {
  id: string;
  kind: 'discord' | 'matrix';
  name: string;
  enabled: boolean;
  /** Discord: the webhook address. A credential: never sent back. */
  webhookUrl: string;
  /**
   * Discord: the name the messages are posted under; blank for the webhook's
   * own. Matrix: the bot's display name in this room; blank for its account's.
   */
  username: string;
  /** Discord: the picture the messages are posted under. */
  avatarUrl: string;
  /** Discord: '' for nobody, '@here', '@everyone', or a role's id. Matrix: '' or '@room'. */
  mention: string;
  /** 'full' has the blurb, the details and the picture; 'compact' a line each (and, on Discord, a thumbnail). */
  style: 'full' | 'compact';
  showImage: boolean;
  /** Matrix: the room, as '!id:server' or '#alias:server'. */
  roomId: string;
  /** Matrix: ordinary messages (the default), or quiet bot notices, which clients grey out and do not alert for. */
  matrixLoud: boolean;
  /** Matrix: answer commands in this room, listing only what this target's filters let through. */
  commands: boolean;
  triggers: NotifyTriggers;
  filters: NotifyFilters;
  /** Hours, local, in which nothing is sent; held until they end. */
  quietHours: { enabled: boolean; from: number; to: number };
}

export interface MatrixBotSettings {
  enabled: boolean;
  /** e.g. "https://matrix.example.org". */
  homeserver: string;
  /** What a command starts with. */
  commandPrefix: string;
  /**
   * Matrix ids that may invite the bot into a room and use the commands that
   * change something. Anyone in a room it is in may use the ones that only read.
   */
  allowedUsers: string[];
  /** Answer commands in rooms no target is set up for, with nothing filtered. */
  commandsEverywhere: boolean;
}

export interface EventArea {
  name: string;
  /** Geocoded from the name when absent. */
  lat?: number;
  lng?: number;
  radiusKm?: number;
}

export interface DensityArea {
  name: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  bbox?: { south: number; west: number; north: number; east: number };
  cellMeters?: number;
  kernelMeters?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  city: '',
  lat: null,
  lng: null,
  radiusKm: 50,
  ticketmasterKey: '',
  seatgeekClientId: '',
  eventbriteToken: '',
  eventbriteOrganizerIds: [],
  fbCookie: '',
  fbSearchTerms: [],
  fbPages: [],
  webSearchTerms: [],
  eventTopics: [],
  eventAreas: [],
  cullOutsideAreas: false,
  excludedCategories: [],
  icalFeeds: [],
  midnightspecStates: [],
  tasksDisabled: [],
  corsOrigins: [],
  crawlerUrl: '',
  crawlerUrls: [],
  llmEnabled: false,
  llmUrl: '',
  llmModel: '',
  llmJobs: ['describe', 'classify', 'extract', 'score'],
  llmIntervalMinutes: 60,
  llmMaxPerRun: 40,
  visionEnabled: false,
  visionModel: '',
  visionIntervalMinutes: 60,
  visionMaxPerRun: 20,
  densityEnabled: false,
  densityIntervalMinutes: 60,
  densityAreas: [],
  densityCities: [],
  densitySearches: [],
  densityPlaces: ['Mount Panorama'],
  densityMaxVenues: 30,
  densityCellMeters: 150,
  densityKernelMeters: 300,
  densityBrowserPath: '',
  notifyTargets: [],
  matrixBot: { enabled: false, homeserver: '', commandPrefix: '!', allowedUsers: [], commandsEverywhere: true },
  matrixAccessToken: '',
  appUrl: '',
  enabledSources: {
    ticketmaster: true,
    seatgeek: true,
    eventbrite: true,
    facebook: true,
    websearch: true,
    ical: true,
    midnightspec: true,
    crawler: true,
  },
};

export interface RawEvent {
  sourceId: string;
  title: string;
  description?: string;
  startTime: string; // ISO 8601
  endTime?: string;
  venueName?: string;
  address?: string;
  lat?: number;
  lng?: number;
  url?: string;
  imageUrl?: string;
  category?: string;
  priceText?: string;
  isOnline?: boolean;
  /**
   * The listing gave a day and no clock time. See when.ts — without it a bare
   * date is stored as UTC midnight and shown as a made-up morning start.
   */
  dateOnly?: boolean;
}

/** Thrown by adapters when required config (API key etc.) is absent. */
export class MissingConfigError extends Error {}

export interface EventSourceAdapter {
  /** Machine name, used as the `source` column and settings key. */
  name: string;
  /** Display name shown in the UI. */
  label: string;
  /** True for sources that scrape rather than use an official API. */
  unofficial?: boolean;
  fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]>;
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
