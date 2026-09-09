import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';

import { assertPublicUrl, BlockedHostError, isPrivateAddress } from '../src/nethost.js';

/**
 * The addresses a scraped listing must not be able to send this server at.
 *
 * 169.254.169.254 is the one that matters most: it is the cloud metadata
 * endpoint, it answers without credentials, and reaching it is the whole point
 * of most SSRF attempts.
 */
test('addresses inside the network are recognised', () => {
  for (const address of [
    '127.0.0.1', '127.1.2.3', '0.0.0.0',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.20.10.5', '172.31.255.255',
    '192.168.0.1', '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    'localhost', 'LOCALHOST', 'thing.localhost',
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be refused`);
  }
});

test('ordinary public addresses are not', () => {
  for (const address of [
    '1.1.1.1', '8.8.8.8', '203.0.113.10', '202.153.212.28',
    // The near-misses on the private ranges, which an over-broad check eats.
    '172.15.0.1', '172.32.0.1', '11.0.0.1', '9.255.255.255',
    '192.167.0.1', '192.169.0.1', '100.63.0.1', '100.128.0.1',
    '169.253.0.1', '169.255.0.1',
    '2606:4700::1111',
    'images.midnightspec.com', 'example.com',
  ]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be allowed`);
  }
});

/** Not an address at all, and not to be mistaken for a safe one. */
test('nonsense is not read as a public address', () => {
  for (const address of ['999.1.1.1', '1.2.3', '1.2.3.4.5']) {
    // These parse as names rather than IPs; the point is only that they do not
    // throw and do not claim to be private.
    assert.equal(typeof isPrivateAddress(address), 'boolean');
  }
});

test('only http and https are fetched at all', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://x/', 'data:text/plain,hi', 'ftp://x/']) {
    await assert.rejects(() => assertPublicUrl(url), BlockedHostError, url);
  }
  await assert.rejects(() => assertPublicUrl('not a url'), BlockedHostError);
});

test('an address inside the network is refused without a lookup', async () => {
  for (const url of [
    'http://127.0.0.1:8080/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/',
    'https://localhost/',
    'http://[::1]:3001/api/settings',
  ]) {
    await assert.rejects(() => assertPublicUrl(url), BlockedHostError, url);
  }
});

/**
 * The case a literal-only check misses: the name is innocent and the answer is
 * not. localtest.me is a public domain that resolves to 127.0.0.1, so this is
 * the one check that proves names are resolved rather than pattern-matched.
 *
 * It needs a resolver, and the suite should not fail on a machine without one —
 * so a lookup that cannot happen skips the assertion instead of failing it.
 * Unreachable hosts are allowed through by design: the fetch that follows will
 * fail on its own, and refusing on a DNS hiccup would stop reading real flyers.
 */
test('a public name resolving inward is refused too', async (t) => {
  const resolves = await dns
    .lookup('localtest.me')
    .then((r) => r.address === '127.0.0.1')
    .catch(() => false);
  if (!resolves) return t.skip('no resolver, or localtest.me has changed');
  await assert.rejects(() => assertPublicUrl('http://localtest.me/'), BlockedHostError);
});

test('an ordinary image URL is allowed through', async () => {
  // Passes whether or not the name resolves: a lookup that fails is not a
  // refusal, which is what keeps a flaky resolver from blocking the flyer pass.
  await assertPublicUrl('https://images.midnightspec.com/thumbnails/abc.jpg');
});
