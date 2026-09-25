import dns from 'node:dns/promises';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { pinnedFetch } from './shared/pinnedFetch.js';

/**
 * Refusing to fetch things inside the network on a stranger's say-so.
 *
 * Event listings arrive from anywhere — Eventbrite, allevents, a Facebook page,
 * an iCal feed — and each brings an image URL that is stored as published and
 * later fetched by the flyer pass. So the address of a server-side request is
 * chosen by whoever wrote the listing, which is the shape of every SSRF: point
 * it at 169.254.169.254, or at a router's admin page, and this app makes the
 * request from inside the LAN where nothing else could reach.
 *
 * The reply never reaches whoever wrote the listing — it goes to a vision model
 * — so the prize is small. But "small" is doing a lot of work in that sentence,
 * and refusing costs one DNS lookup.
 *
 * Names are resolved rather than pattern-matched, because `internal.example.com`
 * resolving to 10.0.0.1 is the same attack as writing 10.0.0.1. That leaves a
 * gap between the check and the connection which a rebinding attack could slip
 * through, so `publicFetch` below also checks the address the connection is
 * actually made to: the lookup that feeds the socket refuses private answers.
 */

/** A parsed IPv4, or null if it is not one. */
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/**
 * Whether an address belongs to this machine, this network, or nowhere.
 *
 * Exported because it is the part worth testing, and it needs no network to be
 * wrong.
 */
export function isPrivateAddress(address: string): boolean {
  const host = address.trim().toLowerCase().replace(/^\[|\]$/g, '');

  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true;                          // "this network"
    if (a === 10) return true;                         // RFC 1918
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // RFC 1918
    if (a === 192 && b === 168) return true;           // RFC 1918
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    if (a === 192 && b === 0) return true;             // protocol assignments
    if (a >= 224) return true;                         // multicast and reserved
    return false;
  }

  // IPv6. Anything mapping onto a v4 address is judged as that address.
  // Node's URL normalises a mapped address to hex groups (`::ffff:7f00:1`),
  // not the dotted form it was typed in, so both are matched here.
  if (host.includes(':')) {
    const dottedMapped = /^(?:::ffff:|64:ff9b::)([\d.]+)$/i.exec(host);
    if (dottedMapped) return isPrivateAddress(dottedMapped[1]);
    const hexMapped = /^(?:::ffff:|64:ff9b::)([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(host);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    if (host === '::' || host === '::1') return true;  // unspecified, loopback
    if (/^f[cd]/i.test(host)) return true;             // unique-local
    if (/^fe[89ab]/i.test(host)) return true;          // link-local
    if (/^ff/i.test(host)) return true;                // multicast
    return false;
  }

  // A bare name. "localhost" is the one worth refusing without a lookup, since
  // a resolver may not answer for it at all.
  return host === 'localhost' || host.endsWith('.localhost');
}

export class BlockedHostError extends Error {}

/**
 * Refuse anything that is not an ordinary http(s) URL pointing somewhere on the
 * public internet. Throws rather than returning false so a caller cannot forget
 * to check the answer.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedHostError('not a URL');
  }
  // file:, data:, gopher: and friends have no business here.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedHostError(`refusing ${url.protocol.replace(':', '')} URL`);
  }
  const host = url.hostname;
  if (isPrivateAddress(host)) throw new BlockedHostError(`refusing private address ${host}`);
  // Already an IP literal and judged public: nothing to look up.
  if (ipv4(host) || host.includes(':')) return;

  let resolved: { address: string }[];
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch {
    // Cannot be reached anyway; let the fetch produce the real error.
    return;
  }
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) {
      throw new BlockedHostError(`${host} resolves to private address ${address}`);
    }
  }
}

/**
 * DNS lookup for outbound sockets that refuses private answers. Because it is
 * the lookup the connection itself uses, a name that resolved publicly for
 * `assertPublicUrl` and privately a moment later (DNS rebinding) is still
 * refused.
 */
export function publicLookup(
  hostname: string,
  options: object,
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    if (list.length === 0) return callback(new BlockedHostError(`${hostname} has no address`), '');
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) return callback(new BlockedHostError(`${hostname} resolves to private address ${bad.address}`), '');
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

const MAX_HOPS = 5;

/**
 * `fetch` for addresses chosen by strangers. Every hop of a redirect is put
 * through `assertPublicUrl` (so a redirect to an IP literal or an odd scheme is
 * refused), and the socket itself only ever connects to a public address.
 */
export async function publicFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertPublicUrl(target);
    const res = await pinnedFetch(target, init, publicLookup as LookupFunction);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) {
      // A constructed Response has no url; callers following a share link need
      // to know where it ended up.
      if (!res.url) Object.defineProperty(res, 'url', { value: target });
      return res;
    }
    await res.body?.cancel().catch(() => undefined);
    try {
      target = new URL(location, target).toString();
    } catch {
      throw new BlockedHostError('bad redirect');
    }
  }
  throw new BlockedHostError('too many redirects');
}

export class TooLargeError extends Error {}

/**
 * Read a response body, giving up once it passes `maxBytes` rather than after
 * the whole thing has been buffered. A declared Content-Length over the cap is
 * refused before reading anything.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooLargeError(`response of ${declared} bytes exceeds ${maxBytes}`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** `readCapped`, decoded as UTF-8 text. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  return (await readCapped(res, maxBytes)).toString('utf8');
}
