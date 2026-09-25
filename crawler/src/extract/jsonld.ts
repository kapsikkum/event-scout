import { CrawledEvent } from '../types.js';
import { isWorthKeeping, parseEnd, parseWhen } from '../shared/when.js';
import { isEventType } from '../shared/eventTypes.js';
import { tidyFind } from '../tidy.js';

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
    return (
      str(obj['@value']) ??
      str(obj.name) ??
      str(obj.headline) ??
      str(obj.text) ??
      str(obj.url) ??
      str(obj.contentUrl) ??
      str(obj['@id'])
    );
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Every node in a document that looks like an Event, however deeply nested. */
function collectEvents(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const n of node) collectEvents(n, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;
  if (isEventType(obj['@type'])) out.push(obj);
  // @graph is how most CMSes wrap a page's whole set of entities, and subEvent
  // is how a festival lists its programme — both hold events worth having.
  for (const key of [
    '@graph', 'subEvent', 'subEvents', 'event', 'events',
    'itemListElement', 'item', 'mainEntity', 'about', 'hasPart',
  ]) {
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

function isPhysicalPlace(loc: unknown): boolean {
  if (!loc || typeof loc !== 'object') return false;
  const obj = loc as Record<string, unknown>;
  if (obj.address != null || obj.geo != null) return true;
  const type = str(obj['@type']) ?? '';
  return /Place/i.test(type);
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
  let loc: Record<string, unknown> | undefined;
  if (Array.isArray(location)) {
    const physical = location.find(isPhysicalPlace);
    loc = (physical ?? location[0]) as Record<string, unknown> | undefined;
  } else {
    loc = location as Record<string, unknown>;
  }
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
  const geoObj = Array.isArray(loc.geo) ? loc.geo[0] : loc.geo;
  const geo = geoObj && typeof geoObj === 'object' ? (geoObj as Record<string, unknown>) : undefined;
  const lat = geo ? (num(geo.latitude) ?? num(geo.lat)) : undefined;
  const lng = geo ? (num(geo.longitude) ?? num(geo.lng) ?? num(geo.lon)) : undefined;

  return {
    venueName: str(loc.name),
    address,
    lat,
    lng,
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

function imageOf(node: Record<string, unknown>): string | undefined {
  const img = node.image;
  if (typeof img === 'string') return img.trim() || undefined;
  if (Array.isArray(img)) {
    for (const item of img) {
      if (typeof item === 'string' && item.trim()) return item.trim();
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const u = str(obj.contentUrl) ?? str(obj.url);
        if (u) return u;
      }
    }
    return undefined;
  }
  if (img && typeof img === 'object') {
    const obj = img as Record<string, unknown>;
    return str(obj.contentUrl) ?? str(obj.url);
  }
  return undefined;
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
      const title = str(node.name) ?? str(node.headline);
      const startRaw = str(node.startDate) ?? str(node.doorTime);
      if (!title || !startRaw) continue;

      const when = parseWhen(str(node.startDate), str(node.doorTime));
      if (!when || !isWorthKeeping(when.startTime, foundAt)) continue;

      const endRaw = str(node.endDate);
      const endTime = endRaw ? parseEnd(endRaw) : undefined;
      const place = placeOf(node);
      const rawUrl = str(node.url);
      // A relative node.url (some sites emit "/events/foo" rather than a full
      // link) has to be resolved against the page it was found on, or it ends
      // up stored as a link nothing can follow.
      const url = rawUrl ? (() => {
        try {
          return new URL(rawUrl, pageUrl).href;
        } catch {
          return pageUrl;
        }
      })() : pageUrl;

      // One event per title+start on a page. Calendars routinely emit the same
      // event twice, once in @graph and once inline.
      const key = `${title.toLowerCase()}|${when.startTime}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const find = tidyFind({
        sourceId: findKey(url, title, when.startTime),
        title,
        description: str(node.description) ?? str(node.text),
        startTime: when.startTime,
        endTime,
        venueName: place.venueName,
        address: place.address,
        lat: place.lat,
        lng: place.lng,
        url,
        imageUrl: imageOf(node),
        priceText: priceOf(node),
        isOnline: place.online,
        dateOnly: when.dateOnly,
        foundAt: foundAt.toISOString(),
        foundOn: pageUrl,
      }, foundAt);
      if (find) out.push(find);
    }
  }
  return out;
}
