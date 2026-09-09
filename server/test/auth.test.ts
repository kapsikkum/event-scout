import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { needsAuth, readCookie, secureEqual, signSession, verifySession } from '../src/auth.js';

const SECRET = crypto.randomBytes(32);

test('reading is open and changing is not', () => {
  for (const path of ['/api/events', '/api/status', '/api/photo', '/api/topics', '/api/density/bathurst', '/api/tasks']) {
    assert.equal(needsAuth('GET', path), false, `${path} should be readable`);
  }
  for (const [method, path] of [
    ['POST', '/api/refresh'],
    ['PUT', '/api/settings'],
    ['POST', '/api/tasks/density/run'],
    ['POST', '/api/tasks/archive/enable'],
    ['POST', '/api/merge'],
    ['POST', '/api/groups/abc'],
    ['POST', '/api/unmerge/abc'],
    ['POST', '/api/archive'],
    ['POST', '/api/density/waze'],
    ['DELETE', '/api/anything'],
  ] as const) {
    assert.equal(needsAuth(method, path), true, `${method} ${path} should be gated`);
  }
});

/**
 * The two the method rule would otherwise wave through, and the reason the
 * classifier is not simply "GET is open".
 */
test('the reads that hand back a secret are gated despite being reads', () => {
  // Every API key, the Facebook cookie and the Waze cookie, in plaintext.
  assert.equal(needsAuth('GET', '/api/settings'), true);
  // The secret that guards the calendar feed; open, it would hand over the
  // very thing it protects.
  assert.equal(needsAuth('GET', '/api/auth/feed-token'), true);
  assert.equal(needsAuth('HEAD', '/api/settings'), true);
});

test('signing in and out never requires being signed in', () => {
  assert.equal(needsAuth('POST', '/api/auth/login'), false);
  assert.equal(needsAuth('POST', '/api/auth/logout'), false);
  assert.equal(needsAuth('GET', '/api/auth/status'), false);
  // Changing the password is not on that list: once one is set it takes a session.
  assert.equal(needsAuth('POST', '/api/auth/password'), true);
});

test('a session token survives a round trip and expires on time', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');
  const token = signSession(now + 60_000, SECRET);
  assert.equal(verifySession(token, SECRET, now), true);
  assert.equal(verifySession(token, SECRET, now + 59_000), true);
  assert.equal(verifySession(token, SECRET, now + 61_000), false);
});

test('a tampered or forged token is refused', () => {
  const now = Date.now();
  const token = signSession(now + 60_000, SECRET);
  const [payload, mac] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];

  // Extending the expiry without being able to re-sign it.
  assert.equal(verifySession(`${now + 9_999_999}.${mac}`, SECRET, now), false);
  // A signature from a different secret.
  assert.equal(verifySession(signSession(now + 60_000, crypto.randomBytes(32)), SECRET, now), false);
  // Flipped characters in the signature.
  assert.equal(verifySession(`${payload}.${mac.slice(0, -2)}xy`, SECRET, now), false);
  // Shapes that are not tokens at all.
  for (const junk of [undefined, '', 'nodot', '.onlymac', `${payload}.`]) {
    assert.equal(verifySession(junk, SECRET, now), false, `${String(junk)} should be refused`);
  }
});

test('comparison tolerates unequal lengths rather than throwing', () => {
  assert.equal(secureEqual('hunter2', 'hunter2'), true);
  assert.equal(secureEqual('hunter2', 'hunter3'), false);
  // The case that makes timingSafeEqual throw if handed the raw strings.
  assert.equal(secureEqual('short', 'a much longer password'), false);
  assert.equal(secureEqual('', ''), true);
  assert.equal(secureEqual('', 'x'), false);
});

test('one cookie is picked out of the header, and a missing one is undefined', () => {
  assert.equal(readCookie('es_session=abc123', 'es_session'), 'abc123');
  assert.equal(readCookie('other=1; es_session=abc123; more=2', 'es_session'), 'abc123');
  assert.equal(readCookie('  es_session = spaced  ', 'es_session'), 'spaced');
  // A name that is only a suffix of another must not match.
  assert.equal(readCookie('not_es_session=nope', 'es_session'), undefined);
  assert.equal(readCookie('other=1', 'es_session'), undefined);
  assert.equal(readCookie(undefined, 'es_session'), undefined);
  // Values are stored url-encoded.
  assert.equal(readCookie('es_session=a%20b', 'es_session'), 'a b');
});
