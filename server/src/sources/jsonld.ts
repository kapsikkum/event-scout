import { RawEvent } from './types.js';

const EVENT_TYPES = new Set([
  'Event',
  'MusicEvent',
  'Festival',
  'TheaterEvent',
  'ComedyEvent',
  'DanceEvent',
  'SportsEvent',
  'ScreeningEvent',
  'SocialEvent',
  'ExhibitionEvent',
  'FoodEvent',
  'VisualArtsEvent',
  'EducationEvent',
  'BusinessEvent',
  'ChildrensEvent',
  'LiteraryEvent',
]);

function typeMatches(type: unknown): boolean {
  if (typeof type === 'string') return EVENT_TYPES.has(type.replace(/^https?:\/\/schema\.org\//, ''));
  if (Array.isArray(type)) return type.some(typeMatches);
  return false;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = firstString(v);
      if (s) return s;
    }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj['@id'] === 'string') return obj['@id'];
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Recursively collect any objects (including nested @graph / subEvent) that look like Events. */
function collectEventNodes(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || !node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectEventNodes(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (typeMatches(obj['@type'])) out.push(obj);
  for (const key of ['@graph', 'subEvent', 'subEvents', 'events', 'itemListElement', 'item']) {
    if (obj[key]) collectEventNodes(obj[key], out, depth + 1);
  }
}

function parseLocation(loc: unknown): { name?: string; address?: string; lat?: number; lng?: number } {
  if (!loc) return {};
  if (typeof loc === 'string') return { name: loc };
  if (Array.isArray(loc)) return parseLocation(loc[0]);
  const obj = loc as Record<string, unknown>;
  const geo = obj.geo as Record<string, unknown> | undefined;
  let address: string | undefined;
  const addr = obj.address;
  if (typeof addr === 'string') address = addr;
  else if (addr && typeof addr === 'object') {
    const a = addr as Record<string, unknown>;
    address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
      .filter((x) => typeof x === 'string')
      .join(', ');
  }
  return {
    name: typeof obj.name === 'string' ? obj.name : undefined,
    address: address || undefined,
    lat: geo ? num(geo.latitude) : undefined,
    lng: geo ? num(geo.longitude) : undefined,
  };
}

function eventFromNode(node: Record<string, unknown>, pageUrl: string): RawEvent | null {
  const name = firstString(node.name);
  const start = typeof node.startDate === 'string' ? node.startDate : undefined;
  if (!name || !start || Number.isNaN(Date.parse(start))) return null;

  const loc = parseLocation(node.location);
  const mode = firstString(node.eventAttendanceMode) ?? '';
  const offers = node.offers as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  const price = offer ? num(offer.price) : undefined;
  const url = firstString(node.url) ?? pageUrl;

  return {
    sourceId: url,
    title: name,
    description: typeof node.description === 'string' ? node.description : '',
    startTime: new Date(start).toISOString(),
    endTime: typeof node.endDate === 'string' && !Number.isNaN(Date.parse(node.endDate)) ? new Date(node.endDate).toISOString() : undefined,
    venueName: loc.name,
    address: loc.address,
    lat: loc.lat,
    lng: loc.lng,
    url,
    imageUrl: firstString(node.image),
    category: (typeof node['@type'] === 'string' ? node['@type'] : 'Event').replace(/Event$/, '') || 'Event',
    priceText: price != null ? (price === 0 ? 'Free' : `from ${price}`) : '',
    isOnline: /OnlineEventAttendanceMode/i.test(mode),
  };
}

/** Extract schema.org Events from a page's <script type="application/ld+json"> blocks. */
export function extractEventsFromHtml(html: string, pageUrl: string): RawEvent[] {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const events: RawEvent[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    let parsed: unknown;
    try {
      // Some sites emit invalid control chars or trailing semicolons; trim defensively.
      parsed = JSON.parse(block[1].trim().replace(/;\s*$/, ''));
    } catch {
      continue;
    }
    const nodes: Record<string, unknown>[] = [];
    collectEventNodes(parsed, nodes);
    for (const node of nodes) {
      const ev = eventFromNode(node, pageUrl);
      if (ev && !seen.has(ev.sourceId)) {
        seen.add(ev.sourceId);
        events.push(ev);
      }
    }
  }
  return events;
}
