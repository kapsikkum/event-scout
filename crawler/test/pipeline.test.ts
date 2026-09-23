import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedFrom } from '../src/seeds.js';
import { config } from '../src/config.js';
import { Interest } from '../src/queries.js';

test('crawler config supports optional ollamaUrl and llmModel', () => {
  assert.equal('ollamaUrl' in config, true);
  assert.equal('llmModel' in config, true);
});

test('seedFrom sequentially falls back across search engines on failure or empty results', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('mojeek.com')) {
      // Mojeek returns 0 results
      return new Response('<html><body>No results</body></html>', { status: 200 });
    }
    if (url.includes('duckduckgo.com')) {
      // DuckDuckGo fails with 202 bot challenge
      return new Response('Anomaly', { status: 202 });
    }
    if (url.includes('bing.com')) {
      // Bing succeeds with result links
      return new Response(
        '<html><body><h2><a href="https://example.com/festivals">Festival</a></h2></body></html>',
        { status: 200 }
      );
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const logs: string[] = [];
  const interest: Interest = { city: 'Bathurst', terms: ['events'] };

  try {
    const added = await seedFrom([interest], (l) => logs.push(l));
    assert.ok(calls.some((u) => u.includes('mojeek.com')), 'tried Mojeek first');
    assert.ok(calls.some((u) => u.includes('duckduckgo.com')), 'fell back to DuckDuckGo');
    assert.ok(calls.some((u) => u.includes('bing.com')), 'fell back to Bing');
    assert.equal(added >= 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('seedFrom does not throw when all search engines fail', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Network error');
  }) as typeof fetch;

  const logs: string[] = [];
  const interest: Interest = { city: 'Bathurst', terms: ['events'] };

  try {
    const added = await seedFrom([interest], (l) => logs.push(l));
    assert.equal(added, 0);
    assert.ok(logs.length > 0, 'logged failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
