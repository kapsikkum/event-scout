import crypto from 'node:crypto';
import { getKv, setKv } from './db.js';
import { scryptHash, secureEqual, signSession, verifySession, SESSION_DAYS } from './auth.js';

/**
 * The half of authentication that reaches the database.
 *
 * Kept apart from the rules in auth.ts so that testing what is protected, and
 * how a cookie is signed, does not open a database.
 */

// --- password ---------------------------------------------------------------

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
