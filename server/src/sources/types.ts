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
   * Collect Waze live-map jams, alerts and wazer positions. Needs a browser:
   * the endpoint refuses scripted requests, so the live map is opened and the
   * responses that page receives are read. Off by default because it opens a
   * window.
   */
  densityWaze: boolean;
  /** Run the Waze pass without a visible window. Scores worse; rarely works. */
  densityWazeHeadless: boolean;
  /** Seconds to leave the Waze window open so the map can be panned by hand. */
  densityWazeHoldSeconds: number;
  /**
   * A Waze cookie exported from the user's own browser. The live-map API needs
   * an account; signing in through the window is the tidier route, but a cookie
   * works and survives a profile reset.
   */
  densityWazeCookie: string;
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
  densityWaze: false,
  densityWazeHeadless: false,
  densityWazeHoldSeconds: 0,
  densityWazeCookie: '',
  enabledSources: {
    ticketmaster: true,
    seatgeek: true,
    eventbrite: true,
    facebook: true,
    websearch: true,
    ical: true,
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
