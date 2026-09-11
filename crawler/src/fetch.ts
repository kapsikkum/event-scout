import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { EMPTY_RULES, isAllowed, parseRobots, RobotsRules } from './robots.js';
import * as store from './store.js';
import { siteOf } from './urls.js';

/**
 * Fetching a page without being a nuisance or a liability.
 *
 * Two separate problems. The nuisance one is robots.txt and rate limiting, and
 * it is why this file exists at all. The liability one is that a crawler
 * follows links chosen by whoever wrote the page, so "fetch this URL" is an
 * instruction from a stranger — the same reasoning as event-scout's nethost.ts,
 * repeated here because the crawler is a separate program and should not be
 * able to reach the LAN whatever event-scout does.
 */

export class BlockedError extends Error {}
export class FetchError extends Error {}

function isPrivateAddress(address: string): boolean {
  const v = net.isIP(address);
  if (v === 4) {
    const p = address.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;      // link-local
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true;                        // multicast, reserved
    return false;
  }
  if (v === 6) {
    const a = address.toLowerCase();
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
    // ::ffff:10.0.0.1 is a v4 address wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/** Refuse anything that resolves onto this network. */
export async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedError('not a url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedError('not http');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new BlockedError(`${host} is not public`);
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedError(`${host} is not public`);
    return;
  }
  // Resolved, not merely inspected: a name is what makes this a real hole —
  // intranet.example.com is a public-looking name pointing at 10.0.0.1.
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new BlockedError(`cannot resolve ${host}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new BlockedError(`${host} resolves to ${address}`);
  }
}

// --- robots -----------------------------------------------------------------

const ROBOTS_TTL_MS = 12 * 3600_000;
const rulesCache = new Map<string, RobotsRules>();

/**
 * The rules for a site, from the database or from the site.
 *
 * A fetch failure is treated as "no rules", which is the conventional reading:
 * a 404 means the site has not asked for anything. A site that is down should
 * not become permanently un-crawlable because of one bad minute.
 */
export async function robotsFor(site: string, sampleUrl: string): Promise<RobotsRules> {
  const cached = rulesCache.get(site);
  if (cached) return cached;

  const row = store.host(site);
  const fresh = row?.robots_at && Date.now() - Date.parse(row.robots_at) < ROBOTS_TTL_MS;
  if (fresh) {
    const rules = parseRobots(row!.robots, config.userAgent);
    rulesCache.set(site, rules);
    return rules;
  }

  const origin = new URL(sampleUrl).origin;
  let body = '';
  try {
    await assertPublicUrl(`${origin}/robots.txt`);
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': config.userAgent, Accept: 'text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    // Only a 2xx is a robots.txt. A 404 is "no rules"; a 500 is not an
    // instruction either way, and treating it as "deny all" would strand sites.
    if (res.ok) body = (await res.text()).slice(0, 512 * 1024);
  } catch {
    body = '';
  }

  const rules = body ? parseRobots(body, config.userAgent) : EMPTY_RULES;
  const delayMs = rules.crawlDelay === null ? null : Math.round(rules.crawlDelay * 1000);
  store.rememberRobots(site, body, delayMs);
  rulesCache.set(site, rules);
  return rules;
}

/** What a site has asked us to wait, within what we are willing to wait. */
export function hostDelayMs(rules: RobotsRules): number {
  const asked = rules.crawlDelay === null ? 0 : rules.crawlDelay * 1000;
  return Math.min(Math.max(asked, config.minHostDelayMs), config.maxHostDelayMs);
}

// --- pages ------------------------------------------------------------------

export interface Page {
  url: string;
  html: string;
}

const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)/i;
const MAX_REDIRECTS = 4;

/**
 * A real browser's navigation, for the one site that needs it.
 *
 * Instagram serves an empty shell to anything that does not look like a
 * browser, the Chrome user agent alone included: the whole set is what gets
 * the page with the caption in it. Kept in step with event-scout's
 * server/src/useragent.ts, which the Facebook reader already uses — a UA that
 * says one version while the client hints say another is the clearer tell.
 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Chromium";v="151", "Microsoft Edge";v="151", "Not=A?Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-ch-ua-platform-version': '"15.0.0"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

/**
 * Fetch one page as HTML, or explain why not.
 *
 * Redirects are followed by hand so every hop is re-checked: a URL that passes
 * the address check can still redirect to one that would not, and
 * `redirect: 'follow'` would take it without asking.
 */
export async function fetchPage(url: string, opts: { browser?: boolean } = {}): Promise<Page> {
  let target = url;
  let res: Response;

  for (let hop = 0; ; hop++) {
    await assertPublicUrl(target);
    try {
      res = await fetch(target, {
        headers: opts.browser
          ? BROWSER_HEADERS
          : {
              'User-Agent': config.userAgent,
              Accept: 'text/html,application/xhtml+xml',
              'Accept-Language': 'en-AU,en;q=0.9',
            },
        redirect: 'manual',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (err) {
      throw new FetchError((err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) break;
    if (hop >= MAX_REDIRECTS) throw new FetchError('too many redirects');
    const next = (() => {
      try {
        return new URL(location, target).toString();
      } catch {
        return null;
      }
    })();
    if (!next) throw new FetchError('bad redirect');
    target = next;
  }

  if (!res.ok) throw new FetchError(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!HTML_TYPE.test(type)) throw new FetchError(`not html (${type.split(';')[0] || 'no type'})`);

  // Declared length first, so an enormous page costs nothing to refuse.
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > config.maxBytes) throw new FetchError(`${Math.round(declared / 1e6)} MB is too large`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > config.maxBytes) throw new FetchError('too large');
  return { url: target, html: buf.toString('utf8') };
}

/** Whether robots.txt permits this URL. */
export async function permitted(url: string): Promise<boolean> {
  const site = siteOf(url);
  if (!site) return false;
  const rules = await robotsFor(site, url);
  return isAllowed(rules, new URL(url).pathname + new URL(url).search);
}
