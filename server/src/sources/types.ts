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
  icalFeeds: [],
  midnightspecStates: [],
  tasksDisabled: [],
  corsOrigins: [],
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
  enabledSources: {
    ticketmaster: true,
    seatgeek: true,
    eventbrite: true,
    facebook: true,
    websearch: true,
    ical: true,
    midnightspec: true,
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
