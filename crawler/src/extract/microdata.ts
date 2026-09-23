import { CrawledEvent } from '../types.js';
import { isWorthKeeping, parseEnd, parseWhen } from '../shared/when.js';
import { isEventType } from '../shared/eventTypes.js';
import { tidyFind } from '../tidy.js';
import { cleanDescription } from '../shared/text.js';

/**
 * Microdata HTML extractor (schema.org Event and subtypes).
 *
 * Microdata is HTML5's built-in structured data mechanism using itemscope,
 * itemtype, and itemprop attributes.
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#039);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

interface DomElement {
  tag: string;
  attrs: Record<string, string>;
  children: (DomElement | string)[];
}

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g;
  for (const m of attrStr.matchAll(re)) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

function parseDom(html: string): DomElement {
  const root: DomElement = { tag: '#root', attrs: {}, children: [] };
  const stack: DomElement[] = [root];

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  const tagRegex = /<(\/)?([a-zA-Z][a-zA-Z0-9:-]*)\b((?:[^"'>]|"[^"]*"|'[^']*')*?)(\/)?>/g;
  let lastIndex = 0;

  for (const m of cleaned.matchAll(tagRegex)) {
    if (m.index! > lastIndex) {
      const text = cleaned.slice(lastIndex, m.index!);
      if (text) {
        stack[stack.length - 1].children.push(decodeEntities(text));
      }
    }
    lastIndex = m.index! + m[0].length;

    const isClose = m[1] === '/';
    const tagName = m[2].toLowerCase();

    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tagName) {
          stack.length = i;
          break;
        }
      }
    } else {
      const attrs = parseAttrs(m[3]);
      const node: DomElement = { tag: tagName, attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      const isSelfClosing = Boolean(m[4]) || VOID_TAGS.has(tagName);
      if (!isSelfClosing) {
        stack.push(node);
      }
    }
  }

  if (lastIndex < cleaned.length) {
    const text = cleaned.slice(lastIndex);
    if (text) {
      stack[stack.length - 1].children.push(decodeEntities(text));
    }
  }

  return root;
}

function getTextContent(node: DomElement | string): string {
  if (typeof node === 'string') return node;
  let out = '';
  for (const child of node.children) {
    out += ' ' + getTextContent(child);
  }
  return out;
}

function getPropertyValue(elem: DomElement): string {
  const tag = elem.tag;
  if ('content' in elem.attrs) {
    return elem.attrs['content'].trim();
  }
  if (tag === 'time' && 'datetime' in elem.attrs) {
    return elem.attrs['datetime'].trim();
  }
  if ((tag === 'a' || tag === 'link' || tag === 'area') && 'href' in elem.attrs) {
    return elem.attrs['href'].trim();
  }
  if (
    (tag === 'img' || tag === 'audio' || tag === 'video' || tag === 'iframe' || tag === 'source' || tag === 'track') &&
    'src' in elem.attrs
  ) {
    return elem.attrs['src'].trim();
  }
  if ((tag === 'data' || tag === 'meter') && 'value' in elem.attrs) {
    return elem.attrs['value'].trim();
  }
  return cleanDescription(getTextContent(elem));
}

export function isSchemaOrgEvent(itemtype?: string): boolean {
  if (!itemtype) return false;
  const types = itemtype.split(/\s+/);
  return types.some((t) => {
    const clean = t.replace(/^https?:\/\/schema\.org\//i, '').trim();
    return isEventType(clean) || /Event$/i.test(clean) || /Event\b/i.test(clean);
  });
}

interface MicrodataItem {
  type: string;
  props: Map<string, (string | MicrodataItem)[]>;
}

function collectItem(elem: DomElement): MicrodataItem {
  const item: MicrodataItem = {
    type: elem.attrs['itemtype'] ?? '',
    props: new Map(),
  };

  function addProp(name: string, val: string | MicrodataItem) {
    const list = item.props.get(name) ?? [];
    list.push(val);
    item.props.set(name, list);
  }

  function walk(node: DomElement) {
    for (const child of node.children) {
      if (typeof child === 'string') continue;

      const hasItemprop = 'itemprop' in child.attrs;
      const hasItemscope = 'itemscope' in child.attrs;

      if (hasItemprop) {
        const propNames = child.attrs['itemprop'].split(/\s+/).filter(Boolean);
        const propValue = hasItemscope ? collectItem(child) : getPropertyValue(child);

        for (const name of propNames) {
          addProp(name, propValue);
        }

        if (!hasItemscope) {
          walk(child);
        }
      } else {
        if (!hasItemscope) {
          walk(child);
        }
      }
    }
  }

  walk(elem);
  return item;
}

function findEventElements(node: DomElement, out: DomElement[] = []): DomElement[] {
  if ('itemscope' in node.attrs && isSchemaOrgEvent(node.attrs['itemtype'])) {
    out.push(node);
  }
  for (const child of node.children) {
    if (typeof child !== 'string') {
      findEventElements(child, out);
    }
  }
  return out;
}

function getFirstString(item: MicrodataItem, prop: string): string | undefined {
  const vals = item.props.get(prop);
  if (!vals) return undefined;
  for (const v of vals) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) return t;
    }
  }
  return undefined;
}

function getFirstItem(item: MicrodataItem, prop: string): MicrodataItem | undefined {
  const vals = item.props.get(prop);
  if (!vals) return undefined;
  for (const v of vals) {
    if (typeof v === 'object' && v !== null) return v;
  }
  return undefined;
}

function getFirstStringOrItem(item: MicrodataItem, prop: string): string | MicrodataItem | undefined {
  const vals = item.props.get(prop);
  if (!vals || vals.length === 0) return undefined;
  return vals[0];
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

export const findKey = (url: string, title: string, startTime: string): string =>
  `${url}#${title.toLowerCase()}|${startTime}`;

/**
 * Parse HTML microdata for schema.org Event entities.
 */
export function eventsFromMicrodata(html: string, pageUrl: string, now = new Date()): CrawledEvent[] {
  const out: CrawledEvent[] = [];
  const seen = new Set<string>();

  const dom = parseDom(html);
  const eventNodes = findEventElements(dom);

  for (const node of eventNodes) {
    const item = collectItem(node);

    const title = getFirstString(item, 'name');
    const startRaw = getFirstString(item, 'startDate');
    if (!title || !startRaw) continue;

    const when = parseWhen(startRaw);
    if (!when || !isWorthKeeping(when.startTime, now)) continue;

    const endRaw = getFirstString(item, 'endDate');
    const endTime = endRaw ? parseEnd(endRaw) : undefined;
    const description = getFirstString(item, 'description');

    const rawUrl = getFirstString(item, 'url');
    const url = rawUrl ? resolveUrl(rawUrl, pageUrl) : pageUrl;

    let imageUrl: string | undefined;
    const imgVal = getFirstStringOrItem(item, 'image');
    if (typeof imgVal === 'string') {
      imageUrl = resolveUrl(imgVal, pageUrl);
    } else if (imgVal && typeof imgVal === 'object') {
      const u = getFirstString(imgVal, 'url') ?? getFirstString(imgVal, 'contentUrl');
      if (u) imageUrl = resolveUrl(u, pageUrl);
    }

    let venueName: string | undefined;
    let address: string | undefined;
    let lat: number | undefined;
    let lng: number | undefined;
    let isOnline = false;

    const mode = getFirstString(item, 'eventAttendanceMode') ?? '';
    if (/online/i.test(mode)) isOnline = true;

    const locVal = getFirstStringOrItem(item, 'location');
    if (typeof locVal === 'string') {
      venueName = locVal;
    } else if (locVal && typeof locVal === 'object') {
      if (/VirtualLocation/i.test(locVal.type)) isOnline = true;
      venueName = getFirstString(locVal, 'name');

      const addrVal = getFirstStringOrItem(locVal, 'address');
      if (typeof addrVal === 'string') {
        address = addrVal;
      } else if (addrVal && typeof addrVal === 'object') {
        const street = getFirstString(addrVal, 'streetAddress');
        const locality = getFirstString(addrVal, 'addressLocality');
        const region = getFirstString(addrVal, 'addressRegion');
        const postal = getFirstString(addrVal, 'postalCode');
        address = [street, locality, region, postal].filter(Boolean).join(', ') || undefined;
      }

      const geoVal = getFirstItem(locVal, 'geo');
      if (geoVal) {
        const latStr = getFirstString(geoVal, 'latitude');
        const lngStr = getFirstString(geoVal, 'longitude');
        if (latStr) lat = parseFloat(latStr);
        if (lngStr) lng = parseFloat(lngStr);
      } else {
        const latStr = getFirstString(locVal, 'latitude');
        const lngStr = getFirstString(locVal, 'longitude');
        if (latStr) lat = parseFloat(latStr);
        if (lngStr) lng = parseFloat(lngStr);
      }
    }

    let priceText: string | undefined;
    const offerVal = getFirstStringOrItem(item, 'offers') ?? getFirstStringOrItem(item, 'offer');
    if (typeof offerVal === 'object' && offerVal !== null) {
      const p = getFirstString(offerVal, 'price') ?? getFirstString(offerVal, 'lowPrice');
      if (p !== undefined) {
        if (/^0(\.0+)?$/.test(p)) {
          priceText = 'Free';
        } else {
          const cur = getFirstString(offerVal, 'priceCurrency') ?? '';
          priceText = `${cur === 'AUD' || cur === 'USD' ? '$' : cur ? cur + ' ' : ''}${p}`;
        }
      }
    } else {
      const directPrice = getFirstString(item, 'price');
      if (directPrice) {
        priceText = /^0(\.0+)?$/.test(directPrice) ? 'Free' : directPrice;
      }
    }

    const key = `${title.toLowerCase()}|${when.startTime}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const sourceId = findKey(url, title, when.startTime);

    const find = tidyFind(
      {
        sourceId,
        title,
        description,
        startTime: when.startTime,
        endTime,
        venueName,
        address,
        lat: Number.isFinite(lat) ? lat : undefined,
        lng: Number.isFinite(lng) ? lng : undefined,
        url,
        imageUrl,
        priceText,
        isOnline,
        dateOnly: when.dateOnly,
        foundAt: now.toISOString(),
        foundOn: pageUrl,
      },
      now
    );

    if (find) out.push(find);
  }

  return out;
}
