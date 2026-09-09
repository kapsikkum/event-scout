import dns from 'node:dns/promises';

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
 * through; closing it properly means resolving once and connecting to the
 * address, which Node's fetch will not do. This is the cheap ninety per cent.
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
  if (host.includes(':')) {
    const mapped = /(?:^::ffff:)([\d.]+)$/i.exec(host);
    if (mapped) return isPrivateAddress(mapped[1]);
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
