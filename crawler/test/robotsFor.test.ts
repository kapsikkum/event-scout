import { test } from 'node:test';
import assert from 'node:assert/strict';

import crypto from 'node:crypto';
import { robotsFor } from '../src/fetch.js';
import { EMPTY_RULES } from '../src/robots.js';

test('robotsFor refuses redirect to private address', async () => {
  const site = `test-ssrf-${crypto.randomUUID()}`;
  const origFetch = globalThis.fetch;
  let privateAddressFetched = false;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      fetchCount++;
      if (url.includes('169.254.169.254')) {
        privateAddressFetched = true;
        return new Response('User-agent: *\nDisallow: /', { status: 200 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/robots.txt' },
      });
    }) as typeof fetch;

    const rules = await robotsFor(site, 'https://example.com/page');
    assert.equal(fetchCount, 1, 'initial robots.txt should be fetched');
    assert.equal(privateAddressFetched, false, 'should not fetch private address on redirect');
    assert.deepEqual(rules, EMPTY_RULES);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('robotsFor halts after 3 redirects', async () => {
  const site = `test-redirects-${crypto.randomUUID()}`;
  const origFetch = globalThis.fetch;
  let hopCount = 0;
  try {
    globalThis.fetch = (async () => {
      hopCount++;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/hop/robots.txt' },
      });
    }) as typeof fetch;

    const rules = await robotsFor(site, 'https://example.com/page');
    // Hop 0, 1, 2, 3 -> exactly 4 fetches (initial + 3 redirects), then stops
    assert.equal(hopCount, 4);
    assert.deepEqual(rules, EMPTY_RULES);
  } finally {
    globalThis.fetch = origFetch;
  }
});
