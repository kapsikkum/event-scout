import crypto from 'node:crypto';
import { getKv, setKv } from './db.js';
import { readBearer, scryptHash, secureEqual, signSession, verifySession, SESSION_DAYS } from './auth.js';

/**
 * The half of authentication that reaches the database.
 *
 * Kept apart from the rules in auth.ts so that testing what is protected, and
 * how a cookie is signed, does not open a database.
 */

// --- password ---------------------------------------------------------------

/** Set or clear the stored password. An empty string turns authentication off. */
export function setPassword(password: string): void {
  // Rotating the session secret invalidates every outstanding session token,
  // since a token is only good as long as the secret that signed it. Without
  // this, changing (or clearing) the password would leave old sessions valid.
  setKv('authSessionSecret', '');
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

export function newSessionToken(): { token: string; maxAgeMs: number } {
  const maxAgeMs = SESSION_DAYS * 24 * 3600 * 1000;
  return { token: signSession(Date.now() + maxAgeMs, sessionSecret()), maxAgeMs };
}

export function sessionValid(token: string | undefined): boolean {
  return verifySession(token, sessionSecret());
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

// --- the API token ----------------------------------------------------------

/**
 * A bearer token, because a script cannot hold a cookie.
 *
 * Signing in is a form post that sets an httpOnly cookie, which is right for a
 * browser and awkward for everything else: a cron job that stars an event or
 * kicks off a refresh would have to log in, keep a cookie jar, and renew it.
 * The token is the same authority in a form `curl -H` can send.
 *
 * The same authority is the point and the risk. It is not a read-only key:
 * anything the password permits, this permits, settings included. So it is
 * treated like the password — never returned without a session, compared
 * without leaking how far the comparison got, and revocable on its own.
 *
 * Absent until asked for, so an instance that never needs one never has one.
 */
export function apiToken(): string {
  return getKv('apiToken') ?? '';
}

export function regenerateApiToken(): string {
  const token = crypto.randomBytes(32).toString('base64url');
  setKv('apiToken', token);
  return token;
}

/** Forget it, so a leaked token can be revoked without setting a new one. */
export function clearApiToken(): void {
  setKv('apiToken', '');
}

/**
 * Whether this request carries the token.
 *
 * Only ever true while a password is required: with none set everything is open
 * anyway, and answering "yes" to a bearer nobody configured would be a lie the
 * rest of the code could come to depend on.
 */
export function apiTokenValid(header: string | undefined): boolean {
  if (!passwordRequired()) return false;
  const stored = apiToken();
  if (!stored) return false;
  const supplied = readBearer(header);
  if (!supplied) return false;
  return secureEqual(supplied, stored);
}

// --- brute force ------------------------------------------------------------

/**
 * A small, deliberately unsophisticated brake on guessing.
 *
 * Not a general rate limiter: one password, one process, and a lockout measured
 * in seconds is enough to make an online guessing attack pointless without ever
 * locking the owner out for long.
 */
export const FREE_ATTEMPTS = 5;
export const LOCKOUT_MS = 30_000;
export const MAX_ATTEMPTS = 10_000;

interface AttemptEntry {
  count: number;
  until: number;
  lastAttempt: number;
}

const attempts = new Map<string, AttemptEntry>();

export function pruneAttempts(now = Date.now()): void {
  for (const [key, entry] of attempts) {
    if (now - entry.lastAttempt > LOCKOUT_MS * 2 && entry.until <= now) {
      attempts.delete(key);
    }
  }
}

export function loginBlockedFor(ip: string, now = Date.now()): number {
  const entry = attempts.get(ip);
  if (!entry) return 0;
  if (now - entry.lastAttempt > LOCKOUT_MS * 2 && entry.until <= now) {
    attempts.delete(ip);
    return 0;
  }
  if (entry.until > 0 && entry.until <= now) {
    entry.count = 0;
    entry.until = 0;
    return 0;
  }
  if (entry.until <= now) return 0;
  return entry.until - now;
}

export function noteLoginFailure(ip: string, now = Date.now()): void {
  pruneAttempts(now);
  if (!attempts.has(ip) && attempts.size >= MAX_ATTEMPTS) {
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  }
  const entry = attempts.get(ip) ?? { count: 0, until: 0, lastAttempt: now };
  if (entry.until > 0 && entry.until <= now) {
    entry.count = 0;
    entry.until = 0;
  }
  if (now - entry.lastAttempt > LOCKOUT_MS) {
    entry.count = 0;
    entry.until = 0;
  }
  entry.count++;
  entry.lastAttempt = now;
  if (entry.count > FREE_ATTEMPTS) {
    entry.until = now + LOCKOUT_MS;
  }
  attempts.delete(ip);
  attempts.set(ip, entry);
}

export function noteLoginSuccess(ip: string): void {
  attempts.delete(ip);
}

export function _resetAttemptsForTest(): void {
  attempts.clear();
}

export function _attemptsCountForTest(): number {
  return attempts.size;
}
