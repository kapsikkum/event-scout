import { test } from 'node:test';
import assert from 'node:assert/strict';

import { corsDecision, matchOrigin, readOrigins } from '../src/cors.js';

const DASH = 'https://dash.example.com';

const get = (over: Partial<Parameters<typeof corsDecision>[0]> = {}) => ({
  origin: DASH,
  method: 'GET',
  path: '/api/events',
  ...over,
});

/**
 * The default, and what the app did before the setting existed. An empty list
 * has to mean "none" rather than "unset, so allow anything".
 */
test('an empty allowlist grants nothing', () => {
  assert.equal(corsDecision(get(), []), null);
});

test('an allowed origin may read the open routes', () => {
  const decision = corsDecision(get(), [DASH]);
  assert.equal(decision?.headers['Access-Control-Allow-Origin'], DASH);
  assert.equal(decision?.preflight, false);
});

/**
 * Not cosmetic. The list carries an ETag, so a cache without this could hand
 * one origin's allowed response to a different origin.
 *
 * Kept out of `headers` on purpose: the route appends it with `res.vary`, and
 * setting it outright dropped the `Vary: Accept-Encoding` that the compressed
 * responses in production carry.
 */
test('every granted response varies on the origin, without replacing what is there', () => {
  assert.equal(corsDecision(get(), [DASH])?.vary, 'Origin');
  assert.equal(corsDecision(get(), ['*'])?.vary, 'Origin');
  assert.equal(corsDecision(get(), [DASH])?.headers.Vary, undefined, 'set() would clobber');
});

/** Without this a caller can read the body but not how many pages there are. */
test('the paging header is exposed, or it may as well not be sent', () => {
  assert.match(corsDecision(get(), [DASH])!.headers['Access-Control-Expose-Headers'], /X-Total-Count/);
});

test('an origin not on the list is refused', () => {
  assert.equal(corsDecision(get({ origin: 'https://evil.example.com' }), [DASH]), null);
  assert.equal(corsDecision(get({ origin: undefined }), [DASH]), null, 'a same-origin request needs no grant');
  // "null" is what a sandboxed iframe or a file:// page sends. Never matched.
  assert.equal(corsDecision(get({ origin: 'null' }), ['*']), null);
});

test('a near-miss is not a match', () => {
  for (const origin of [
    'https://dash.example.com.evil.test',
    'http://dash.example.com',
    'https://evil.com?x=https://dash.example.com',
  ]) {
    assert.equal(corsDecision(get({ origin }), [DASH]), null, `${origin} should not match`);
  }
  // Case and a trailing slash are not real differences, though.
  assert.equal(matchOrigin('https://DASH.example.com', [DASH]), 'https://DASH.example.com');
  assert.equal(matchOrigin(DASH, ['https://dash.example.com/']), DASH);
});

/**
 * The rule that makes a wildcard survivable. With no password set every write
 * is open to the network, and granting those across origins would let any page
 * the user visits rewrite their settings.
 */
test('a write is never granted, however wide the list', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(corsDecision(get({ method, path: '/api/refresh' }), ['*']), null, `${method} should be refused`);
    // Including as the method a preflight is asking about.
    assert.equal(
      corsDecision(get({ method: 'OPTIONS', requestMethod: method, path: '/api/refresh' }), ['*']),
      null,
      `a preflight for ${method} should be refused`
    );
  }
});

/**
 * These two hand back API keys and the calendar secret. They are already gated
 * by password — but with none set they would otherwise be readable by any page
 * the user visits, which is exactly the wrong thing to open up.
 */
test('the reads that carry secrets are never granted either', () => {
  assert.equal(corsDecision(get({ path: '/api/settings' }), ['*']), null);
  assert.equal(corsDecision(get({ path: '/api/auth/feed-token' }), ['*']), null);
  // While the ordinary reads are.
  for (const path of ['/api/events', '/api/status', '/api/density/bathurst', '/api/version']) {
    assert.ok(corsDecision(get({ path }), ['*']), `${path} should be readable`);
  }
});

/**
 * Credentials are never claimed: the session cookie is sameSite=lax and so is
 * not sent cross-site anyway, and saying otherwise would promise a caller
 * something that does not work.
 */
test('credentials are never allowed', () => {
  const decision = corsDecision(get(), [DASH]);
  assert.equal(decision?.headers['Access-Control-Allow-Credentials'], undefined);
});

test('a preflight for a read is answered with what it asked', () => {
  const decision = corsDecision(get({ method: 'OPTIONS', requestMethod: 'GET' }), [DASH]);
  assert.equal(decision?.preflight, true);
  assert.match(decision!.headers['Access-Control-Allow-Methods'], /GET/);
  assert.match(decision!.headers['Access-Control-Allow-Headers'], /If-None-Match/);
  assert.ok(decision!.headers['Access-Control-Max-Age']);
});

/**
 * A wildcard still echoes the caller rather than a literal "*", so the response
 * stays correct for a cache honouring Vary.
 */
test('a wildcard echoes the caller, not a star', () => {
  assert.equal(corsDecision(get({ origin: 'http://localhost:5173' }), ['*'])
    ?.headers['Access-Control-Allow-Origin'], 'http://localhost:5173');
});

test('the setting is read into origins, and junk is dropped', () => {
  assert.deepEqual(readOrigins([' https://dash.example.com/ ']), [DASH]);
  assert.deepEqual(readOrigins(['https://a.test', 'https://a.test']), ['https://a.test'], 'no duplicates');
  assert.deepEqual(readOrigins(['*']), ['*']);
  // A path cannot match anything a browser sends, so it is repaired.
  assert.deepEqual(readOrigins(['https://dash.example.com/app']), [DASH]);
  // Neither a URL nor a scheme worth allowing.
  assert.deepEqual(readOrigins(['dash.example.com', '', 'file:///x', 7, null]), []);
  assert.deepEqual(readOrigins('https://a.test'), [], 'not an array at all');
  assert.deepEqual(readOrigins(undefined), []);
});
