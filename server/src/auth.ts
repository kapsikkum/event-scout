import crypto from 'node:crypto';

/**
 * One shared password, and a rule about what it protects.
 *
 * The app had none at all: every route was open, and `docker-compose.yml`
 * publishes 3001 on every interface. Anyone who could reach the port could
 * change the settings, and — worse — read them, since that response carries the
 * Facebook cookie and every API key in plaintext. Those are redacted now —
 * see secrets.ts — but the response still carries everything else about how
 * this instance is configured, so it stays gated.
 *
 * Deliberately small: no session library, no JWTs, a signed cookie over
 * `node:crypto`. The dependency list is short everywhere else in this project
 * and there is nothing here worth a package for.
 *
 * This half is pure: what needs protecting, and how a cookie is signed and
 * checked. The half that reaches the database lives in authStore.ts. They were
 * one file until the tests for these rules opened a database to reach them and
 * raced another test file's migrations on a fresh one.
 */

export const SESSION_COOKIE = 'es_session';


// --- what the password protects ---------------------------------------------

/** Signing in and out cannot itself require being signed in. */
const OPEN_ROUTES = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/status']);

/**
 * Reads that hand back a secret, and so cannot ride on "GET is open".
 *
 * These are the whole reason the rule is not simply about the method.
 * `/api/settings` no longer returns the credentials themselves, but still every
 * search term, feed URL and area this instance watches;
 * `/api/auth/feed-token` returns the secret that guards the calendar feed, and
 * `/api/auth/token` the bearer that stands in for the password itself. Leaving
 * any of them open would hand over the thing it protects.
 */
const GATED_READS = new Set(['/api/settings', '/api/auth/feed-token', '/api/auth/token', '/api/notify/status']);

/**
 * Whether a request needs a signed-in session.
 *
 * Classified here rather than route by route, because a per-route sprinkle is
 * how one gets forgotten: a route added later is covered by this by default.
 * Reading is open, changing anything is not, and the two reads above are
 * called out by name.
 */
export function needsAuth(method: string, path: string): boolean {
  if (OPEN_ROUTES.has(path)) return false;
  if (GATED_READS.has(path)) return true;
  return method !== 'GET' && method !== 'HEAD';
}


function scryptHash(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/**
 * Compare without leaking how far the comparison got.
 *
 * Both sides are hashed to a fixed width first: `timingSafeEqual` throws on a
 * length mismatch, and catching that would put the length back into the timing.
 */
export function secureEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a, 'utf8').digest();
  const bh = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

export { scryptHash };

/** `<expiry>.<hmac>`, where the hmac covers the expiry. */
export function signSession(expiresAt: number, secret: Buffer): string {
  const payload = String(expiresAt);
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifySession(token: string | undefined, secret: Buffer, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const expiry = Number(payload);
  return Number.isFinite(expiry) && expiry > now;
}

/** Pull one cookie out of a Cookie header, without a parser dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The token out of an `Authorization: Bearer ...` header.
 *
 * Parsing lives here with the other rules rather than beside the stored value,
 * so what counts as a well-formed header can be checked without a database.
 * The scheme is case-insensitive per RFC 7235, and a header with no credentials
 * after it is nothing rather than an empty token — which would otherwise
 * compare equal to an unset secret.
 */
export function readBearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S.*)$/i.exec((header ?? '').trim());
  return match ? match[1].trim() || undefined : undefined;
}

/** How long a sign-in lasts. Long, because this is a tool you leave open. */
export const SESSION_DAYS = 30;
