import crypto from 'node:crypto';
import { getKv, setKv } from './db.js';

/**
 * One shared password, and a rule about what it protects.
 *
 * The app had none at all: every route was open, and `docker-compose.yml`
 * publishes 3001 on every interface. Anyone who could reach the port could
 * change the settings, and — worse — read them, since that response carries the
 * Facebook cookie and every API key in plaintext.
 *
 * Deliberately small: no session library, no JWTs, a signed cookie over
 * `node:crypto`. The dependency list is short everywhere else in this project
 * and there is nothing here worth a package for.
 */

export const SESSION_COOKIE = 'es_session';

/** How long a sign-in lasts. Long, because this is a tool you leave open. */
const SESSION_DAYS = 30;

// --- what the password protects ---------------------------------------------

/** Signing in and out cannot itself require being signed in. */
const OPEN_ROUTES = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/status']);

/**
 * Reads that hand back a secret, and so cannot ride on "GET is open".
 *
 * These two are the whole reason the rule is not simply about the method.
 * `/api/settings` returns the Facebook cookie and every API key in plaintext; `/api/auth/feed-token` returns the secret that guards the
 * calendar feed, so leaving it open would hand over the thing it protects.
 */
const GATED_READS = new Set(['/api/settings', '/api/auth/feed-token']);

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

// --- password ---------------------------------------------------------------

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

/** Set or clear the stored password. An empty string turns authentication off. */
export function setPassword(password: string): void {
  if (!password) {
    setKv('authPasswordHash', '');
    setKv('authPasswordSalt', '');
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  setKv('authPasswordSalt', salt);
  setKv('authPasswordHash', scryptHash(password, salt));
}

/**
 * Whether anything is protected at all.
 *
 * `AUTH_PASSWORD` wins when set, so a container can be locked down without
 * anybody visiting the UI first. With neither, the app behaves exactly as it
 * did before this existed — which the Settings page says out loud, rather than
 * leaving it to be discovered.
 */
export function passwordRequired(): boolean {
  return Boolean(process.env.AUTH_PASSWORD || getKv('authPasswordHash'));
}

export function checkPassword(attempt: string): boolean {
  const fromEnv = process.env.AUTH_PASSWORD;
  if (fromEnv) return secureEqual(attempt, fromEnv);
  const salt = getKv('authPasswordSalt');
  const hash = getKv('authPasswordHash');
  if (!salt || !hash) return false;
  return secureEqual(scryptHash(attempt, salt), hash);
}

/** True when the password lives in the environment, so the UI cannot change it. */
export function passwordIsFromEnv(): boolean {
  return Boolean(process.env.AUTH_PASSWORD);
}

// --- sessions ---------------------------------------------------------------

/** Persisted, so signing in survives a restart. */
function sessionSecret(): Buffer {
  let hex = getKv('authSessionSecret');
  if (!hex) {
    hex = crypto.randomBytes(32).toString('hex');
    setKv('authSessionSecret', hex);
  }
  return Buffer.from(hex, 'hex');
}

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

export function newSessionToken(): { token: string; maxAgeMs: number } {
  const maxAgeMs = SESSION_DAYS * 24 * 3600 * 1000;
  return { token: signSession(Date.now() + maxAgeMs, sessionSecret()), maxAgeMs };
}

export function sessionValid(token: string | undefined): boolean {
  return verifySession(token, sessionSecret());
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

// --- the calendar feed ------------------------------------------------------

/**
 * A secret in the feed URL, because a calendar client cannot sign in.
 *
 * Subscribing is a GET and stays reachable, but the feed carries the shortlist,
 * so once a password is set the URL has to carry something. Generated on first
 * use and only enforced once a password exists, which keeps URLs already
 * subscribed to working right up until authentication is turned on.
 */
export function feedToken(): string {
  let token = getKv('feedToken');
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    setKv('feedToken', token);
  }
  return token;
}

export function regenerateFeedToken(): string {
  const token = crypto.randomBytes(24).toString('base64url');
  setKv('feedToken', token);
  return token;
}

export function feedTokenValid(supplied: unknown): boolean {
  if (!passwordRequired()) return true;
  return typeof supplied === 'string' && supplied.length > 0 && secureEqual(supplied, feedToken());
}

// --- brute force ------------------------------------------------------------

/**
 * A small, deliberately unsophisticated brake on guessing.
 *
 * Not a general rate limiter: one password, one process, and a lockout measured
 * in seconds is enough to make an online guessing attack pointless without ever
 * locking the owner out for long.
 */
const FREE_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;
const attempts = new Map<string, { count: number; until: number }>();

export function loginBlockedFor(ip: string, now = Date.now()): number {
  const entry = attempts.get(ip);
  if (!entry || entry.until <= now) return 0;
  return entry.until - now;
}

export function noteLoginFailure(ip: string, now = Date.now()): void {
  const entry = attempts.get(ip) ?? { count: 0, until: 0 };
  entry.count++;
  if (entry.count > FREE_ATTEMPTS) entry.until = now + LOCKOUT_MS;
  attempts.set(ip, entry);
}

export function noteLoginSuccess(ip: string): void {
  attempts.delete(ip);
}
