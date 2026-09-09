import { needsAuth } from './auth.js';

/**
 * Letting a page on another address read the list.
 *
 * A browser refuses a cross-origin fetch unless the server says otherwise, so
 * without this a dashboard served from anywhere but this app's own address
 * cannot call the API at all. Which origins are allowed is the operator's to
 * decide, so it is a setting rather than a constant.
 *
 * What is granted is deliberately narrower than what the allowlist names, and
 * the narrowing is the important part:
 *
 * 1. Only the requests that are already open to anyone who can reach the port.
 *    `needsAuth` decides, which means one rule rather than two that can drift:
 *    reading is open, changing anything is not, and `/api/settings` and
 *    `/api/auth/feed-token` stay out because they hand back API keys and the
 *    calendar secret.
 *
 * 2. No `Access-Control-Allow-Credentials`. The session cookie is `sameSite:
 *    lax` and so is not sent on a cross-site write in any case; claiming
 *    credentials would promise something that does not work, and would widen
 *    what an allowlisted origin could do if the cookie policy ever loosened.
 *
 * 3. Never a reflected origin. The header echoes the request's origin only
 *    after an exact match against the list, so a bug here cannot turn into
 *    "any site may read this".
 *
 * Together those mean the worst an allowlisted origin — even `*` — can do is
 * read what any unauthenticated client on the network could already read. That
 * matters most with no password set, where a bare "allow everything" would
 * otherwise let any page the user happens to visit rewrite their settings.
 */

/** Safe methods, which is all that is ever granted across origins. */
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

/**
 * Worth naming explicitly: without this a cross-origin caller can see the body
 * but not `X-Total-Count`, which is how it would know there are more pages.
 */
const EXPOSED = 'X-Total-Count, ETag';

/** What a caller may send. Enough for conditional gets and JSON. */
const ALLOWED_HEADERS = 'Content-Type, If-None-Match';

/** How long a browser may cache the preflight. Ten minutes. */
const MAX_AGE = '600';

/** Compare origins the way the spec does: scheme and host are case-insensitive. */
function normalise(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Whether this origin is on the list, and what to echo back if so.
 *
 * `*` on the list means any origin. It still echoes the caller's own origin
 * rather than a literal `*`, so the response stays correct for a caching proxy
 * that honours `Vary: Origin`.
 */
export function matchOrigin(origin: string | undefined, allowed: string[]): string | null {
  if (!origin) return null;
  const want = normalise(origin);
  if (!want || want === 'null') return null;
  for (const entry of allowed) {
    const e = normalise(entry);
    if (e === '*' || e === want) return origin;
  }
  return null;
}

export interface CorsRequest {
  origin: string | undefined;
  method: string;
  path: string;
  /** The method a preflight is asking about, from `Access-Control-Request-Method`. */
  requestMethod?: string;
}

export interface CorsDecision {
  headers: Record<string, string>;
  /**
   * Carried separately because it has to be *added* to whatever else the
   * response already varies on. Setting it outright dropped the
   * `Vary: Accept-Encoding` that sits on the compressed responses in
   * production, which would let a cache serve a gzipped body to a client that
   * had not asked for one. The route appends it with `res.vary`.
   */
  vary: string;
  /** True when this is a preflight to answer here rather than pass on. */
  preflight: boolean;
}

/**
 * The headers to add, or null to leave the response as it would have been.
 *
 * A refusal is silent by design: the browser blocks the read and reports it,
 * and answering a preflight with an error would say more about the allowlist
 * than a stranger needs to know.
 */
export function corsDecision(req: CorsRequest, allowed: string[]): CorsDecision | null {
  if (allowed.length === 0) return null;
  const origin = matchOrigin(req.origin, allowed);
  if (!origin) return null;

  const preflight = req.method === 'OPTIONS' && Boolean(req.requestMethod);
  // On a preflight the question is about the method it names, not OPTIONS.
  const method = preflight ? req.requestMethod! : req.method;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return null;
  // The same rule the whole API is gated by, rather than a second list to keep
  // in step with it.
  if (needsAuth(method, req.path)) return null;

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': EXPOSED,
  };
  if (preflight) {
    headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
    headers['Access-Control-Allow-Headers'] = ALLOWED_HEADERS;
    headers['Access-Control-Max-Age'] = MAX_AGE;
  }
  // Mandatory, not cosmetic: the responses carry ETags, and without this a
  // cache could hand one origin's allowed response to a different origin.
  return { headers, vary: 'Origin', preflight };
}

/**
 * Read the setting into a list, dropping what could not work.
 *
 * An origin is a scheme and a host, with no path — `https://dash.example.com`,
 * not `https://dash.example.com/`. A browser sends exactly that in the `Origin`
 * header, so an entry carrying a path would never match anything and is better
 * repaired than silently kept.
 */
export function readOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === '*') {
      out.push('*');
      continue;
    }
    try {
      const url = new URL(entry);
      if (!/^https?:$/.test(url.protocol)) continue;
      out.push(`${url.protocol}//${url.host}`);
    } catch {
      // Not a URL at all. Dropped rather than guessed at.
    }
  }
  return [...new Set(out)];
}
