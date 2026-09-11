import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';

/**
 * Events from the crawler, which is a separate program.
 *
 * It runs beside this one, keeps its own database and its own frontier, and is
 * asked rather than listened to: this adapter fetches what it has found when a
 * refresh comes round, and everything after that — validation, geocoding,
 * dedupe, archiving, the model passes — happens exactly as it does for any
 * other source. So a crawler that returns nonsense is a switch in Settings and
 * nothing worse, and it never holds a credential for this app or writes a row.
 *
 * The area travels with the request. The crawler has no configuration of its
 * own about where to look, which keeps Settings the single place that decides.
 */

const TIMEOUT_MS = 20000;

/** What the crawler sends. Its own shape, close to but not the same as ours. */
interface CrawledEvent {
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
  dateOnly?: boolean;
}

function baseUrl(settings: Settings): string {
  const url = settings.crawlerUrl.trim() || process.env.CRAWLER_URL || '';
  return url.replace(/\/+$/, '');
}

export const crawlerSource: EventSourceAdapter = {
  name: 'crawler',
  label: 'Web crawler',
  unofficial: true,

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    const base = baseUrl(settings);
    if (!base) {
      throw new MissingConfigError(
        'No crawler address. Run the crawler container and set its URL in Settings.'
      );
    }

    const query = new URLSearchParams({
      city: loc.city,
      lat: String(loc.lat),
      lng: String(loc.lng),
      radiusKm: String(loc.radiusKm),
    });
    // The terms this app already searches for, so the crawler seeds on the same
    // interests rather than guessing at a second list.
    const terms = settings.webSearchTerms.filter(Boolean).slice(0, 10);
    if (terms.length) query.set('terms', terms.join(','));

    let res: Response;
    try {
      res = await fetch(`${base}/events?${query}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = (err as Error).name === 'TimeoutError' ? 'no answer' : (err as Error).message;
      throw new Error(`Cannot reach the crawler at ${base}: ${reason}`);
    }
    if (!res.ok) throw new Error(`The crawler answered HTTP ${res.status}`);

    const body = (await res.json()) as { events?: CrawledEvent[] };
    const events = Array.isArray(body.events) ? body.events : [];

    return events
      .filter((e) => e && typeof e.title === 'string' && typeof e.startTime === 'string')
      .map((e): RawEvent => ({
        // Prefixed so a crawled listing can never collide with one scraped
        // directly, and so it is obvious in the database where a row came from.
        sourceId: `crawl:${e.sourceId}`.slice(0, 400),
        title: e.title,
        description: e.description,
        startTime: e.startTime,
        endTime: e.endTime,
        venueName: e.venueName,
        address: e.address,
        lat: e.lat,
        lng: e.lng,
        url: e.url,
        imageUrl: e.imageUrl,
        priceText: e.priceText,
        isOnline: e.isOnline,
      }));
  },
};
