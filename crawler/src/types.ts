/** What the crawler finds, and hands to event-scout over its own API. */
export interface CrawledEvent {
  /** Stable across re-crawls: the page it came from plus its title. */
  sourceId: string;
  title: string;
  description?: string;
  startTime: string;
  endTime?: string;
  venueName?: string;
  address?: string;
  lat?: number;
  lng?: number;
  url?: string;
  imageUrl?: string;
  priceText?: string;
  isOnline?: boolean;
  /** The page gave a day and no clock time. See extract/when.ts. */
  dateOnly?: boolean;
  /** Where it was found, for the status page and for debugging a bad find. */
  foundAt: string;
  foundOn: string;
}

/** A page the crawler knows about, whether or not it has been fetched. */
export interface FrontierRow {
  url: string;
  site: string;
  depth: number;
  score: number;
  state: 'queued' | 'done' | 'failed' | 'skipped';
  discoveredAt: string;
  fetchedAt: string | null;
  events: number;
  note: string;
}
