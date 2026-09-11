import { CrawledEvent } from '../types.js';
import { isWorthKeeping, parseEnd, parseWhen } from './when.js';

/**
 * schema.org/Event out of a page's JSON-LD.
 *
 * The reason a general crawler is worth building at all: a venue's own site, a
 * council's what's-on, a ticketing plugin and a WordPress calendar all publish
 * the same vocabulary, so one extractor reaches thousands of sites that would
 * otherwise need a scraper each.
 *
 * Only JSON-LD. Microdata and RDFa say the same things and almost nobody emits
 * them any more; if that changes it belongs here as a second reader rather than
 * as a rewrite of this one.
 */

const EVENT_TYPES = new Set([
  'Event', 'MusicEvent', 'Festival', 'TheaterEvent', 'ComedyEvent', 'DanceEvent',
  'SportsEvent', 'ScreeningEvent', 'SocialEvent', 'ExhibitionEvent', 'FoodEvent',
  'VisualArtsEvent', 'EducationEvent', 'BusinessEvent', 'ChildrensEvent',
  'LiteraryEvent', 'CourseInstance', 'PublicationEvent', 'DeliveryEvent',
]);

function typeMatches(type: unknown): boolean {
  if (typeof type === 'string') return EVENT_TYPES.has(type.replace(/^https?:\/\/schema\.org\//, ''));
  if (Array.isArray(type)) return type.some(typeMatches);
  return false;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = str(v);
      if (s) return s;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return str(obj.name) ?? str(obj.url) ?? str(obj['@id']);
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Strip tags and collapse whitespace: descriptions often arrive as HTML. */
function plain(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim() || undefined;
}

/** Every node in a document that looks like an Event, however deeply nested. */
function collectEvents(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const n of node) collectEvents(n, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;
  if (typeMatches(obj['@type'])) out.push(obj);
  // @graph is how most CMSes wrap a page's whole set of entities, and subEvent
  // is how a festival lists its programme — both hold events worth having.
  for (const key of ['@graph', 'subEvent', 'subEvents', 'event', 'events', 'itemListElement', 'item']) {
    if (key in obj) collectEvents(obj[key], out);
  }
  return out;
}

/** The `<script type="application/ld+json">` blocks, parsed and forgiving. */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const body = m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    if (!body) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      // Trailing commas and unescaped newlines are common enough in the wild
      // that one repair attempt pays for itself; anything worse is not ours.
      try {
        out.push(JSON.parse(body.replace(/,\s*([}\]])/g, '$1')));
      } catch {
        /* not our problem */
      }
    }
  }
  return out;
}

function placeOf(node: Record<string, unknown>): {
  venueName?: string; address?: string; lat?: number; lng?: number; online: boolean;
} {
  const location = node.location;
  const mode = str(node.eventAttendanceMode) ?? '';
  const online = /online/i.test(mode);
  if (!location || typeof location !== 'object') {
    return { venueName: str(location), online };
  }
  const loc = (Array.isArray(location) ? location[0] : location) as Record<string, unknown>;
  if (!loc || typeof loc !== 'object') return { online };

  const addr = loc.address;
  let address: string | undefined;
  if (typeof addr === 'string') address = addr.trim() || undefined;
  else if (addr && typeof addr === 'object') {
    const a = addr as Record<string, unknown>;
    address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
      .map((p) => str(p))
      .filter(Boolean)
      .join(', ') || undefined;
  }
  const geo = loc.geo as Record<string, unknown> | undefined;
  return {
    venueName: str(loc.name),
    address,
    lat: geo ? num(geo.latitude) : undefined,
    lng: geo ? num(geo.longitude) : undefined,
    online: online || /VirtualLocation/i.test(str(loc['@type']) ?? ''),
  };
}

function priceOf(node: Record<string, unknown>): string | undefined {
  const offers = node.offers;
  const first = (Array.isArray(offers) ? offers[0] : offers) as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return undefined;
  const price = str(first.price) ?? str(first.lowPrice);
  if (price === undefined) return undefined;
  if (/^0(\.0+)?$/.test(price)) return 'Free';
  const currency = str(first.priceCurrency) ?? '';
  return `${currency === 'AUD' || currency === 'USD' ? '$' : currency ? currency + ' ' : ''}${price}`;
}

/**
 * A find's identity: the event's own link, its title and its start.
 *
 * Not the page it was read on. One event turns up on its own page, on the
 * calendar, on a category page and on every tag page — and on allevents.in on
 * a page per suburb — and keyed on the page, each of those was a separate find:
 * 4,387 finds for 2,144 events, arriving in the app as "16 listings".
 */
export const findKey = (url: string, title: string, startTime: string): string =>
  `${url}#${title.toLowerCase()}|${startTime}`;

/**
 * Events from one fetched page.
 *
 * `pageUrl` is the fallback link, for an event that does not name its own. Two
 * sites listing the same event still get an id each, which leaves the merging
 * to event-scout, which already knows how.
 */
export function eventsFromHtml(html: string, pageUrl: string, foundAt = new Date()): CrawledEvent[] {
  const out: CrawledEvent[] = [];
  const seen = new Set<string>();

  for (const block of jsonLdBlocks(html)) {
    for (const node of collectEvents(block)) {
      const title = plain(node.name);
      const startRaw = str(node.startDate);
      if (!title || !startRaw) continue;

      const when = parseWhen(startRaw);
      if (!when || !isWorthKeeping(when.startTime, foundAt)) continue;

      const endRaw = str(node.endDate);
      const endTime = endRaw ? parseEnd(endRaw) : undefined;
      const place = placeOf(node);
      const url = str(node.url) ?? pageUrl;

      // One event per title+start on a page. Calendars routinely emit the same
      // event twice, once in @graph and once inline.
      const key = `${title.toLowerCase()}|${when.startTime}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        sourceId: findKey(url, title, when.startTime),
        title,
        description: plain(node.description),
        startTime: when.startTime,
        endTime,
        venueName: place.venueName,
        address: place.address,
        lat: place.lat,
        lng: place.lng,
        url,
        imageUrl: str(node.image),
        priceText: priceOf(node),
        isOnline: place.online,
        dateOnly: when.dateOnly,
        foundAt: foundAt.toISOString(),
        foundOn: pageUrl,
      });
    }
  }
  return out;
}
