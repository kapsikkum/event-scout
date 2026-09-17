import { CrawledEvent } from './types.js';
import { cleanDescription, cleanLine, NOT_AN_ADDRESS } from './shared/text.js';
import { isWorthKeeping, MAX_DURATION_MS } from './shared/when.js';

/**
 * A find as event-scout should receive it, or null when it is not one.
 *
 * The crawler reads pages and says what they say, tidily. It does not decide
 * what an event is about or where it is beyond what the page states: a caption
 * that mentions Bathurst is not an event in Bathurst, and guessing so put a
 * Sydney track day there. Placing, categorising and judging belong to
 * event-scout, which can see every listing at once.
 *
 * Checked: a title with words in it, a start inside the window, an end that
 * follows the start and is believable, coordinates on the planet, and links
 * that are web addresses. Tidied: entities, tags and stray whitespace, and
 * placeholder venues ("TBA") dropped rather than passed on as places.
 */
export function tidyFind(ev: CrawledEvent, now = new Date()): CrawledEvent | null {
  const title = cleanLine(ev.title).slice(0, 300);
  if (title.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return null;
  if (!isWorthKeeping(ev.startTime, now)) return null;

  const start = Date.parse(ev.startTime);
  const end = ev.endTime ? Date.parse(ev.endTime) : NaN;
  const endTime = end > start && end - start <= MAX_DURATION_MS ? new Date(end).toISOString() : undefined;

  const place = (text: string | undefined): string | undefined => {
    const line = cleanLine(text).slice(0, 300);
    return line && !NOT_AN_ADDRESS.test(line) ? line : undefined;
  };
  const coord = (value: number | undefined, limit: number): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
  let lat = coord(ev.lat, 90);
  let lng = coord(ev.lng, 180);
  // Null Island: a CMS's empty map pin, not a place.
  if (lat === undefined || lng === undefined || (lat === 0 && lng === 0)) lat = lng = undefined;
  const link = (url: string | undefined): string | undefined => (url && /^https?:\/\/\S+$/i.test(url) ? url : undefined);

  const out: CrawledEvent = {
    sourceId: ev.sourceId,
    title,
    description: cleanDescription(ev.description).slice(0, 4000) || undefined,
    startTime: new Date(start).toISOString(),
    endTime,
    venueName: place(ev.venueName),
    address: place(ev.address),
    lat,
    lng,
    url: link(ev.url),
    imageUrl: link(ev.imageUrl),
    priceText: cleanLine(ev.priceText).slice(0, 80) || undefined,
    isOnline: ev.isOnline,
    dateOnly: ev.dateOnly,
    foundAt: ev.foundAt,
    foundOn: ev.foundOn,
  };
  // Left out rather than sent as undefined, so a stored find stays small.
  for (const key of Object.keys(out) as (keyof CrawledEvent)[]) if (out[key] === undefined) delete out[key];
  return out;
}
