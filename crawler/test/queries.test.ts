import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TERMS, queriesFor } from '../src/queries.js';
import { parseEnd } from '../src/extract/when.js';

/**
 * Taking the first few phrases, which is what this did before, meant the rest
 * of a long list never ran. A window that moves each hour reaches all of it.
 */
test('every phrase comes round, a window at a time', () => {
  const interest = { city: 'Bathurst', terms: Array.from({ length: 20 }, (_, i) => `term${i}`) };
  const seen = new Set<string>();
  for (let hour = 0; hour < 5; hour++) {
    const window = queriesFor(interest, 8, hour * 3600_000);
    assert.equal(window.length, 8, 'a full window every hour');
    for (const q of window) seen.add(q);
  }
  assert.equal(seen.size, 20, 'the whole list within a few hours');
});

test('a short list is used whole, each phrase naming the place', () => {
  assert.deepEqual(
    queriesFor({ city: 'Bathurst', terms: ['markets', 'car show', 'markets'] }),
    ['markets Bathurst', 'car show Bathurst']
  );
});

test('no terms falls back on the general list, and no place means no searching', () => {
  assert.equal(queriesFor({ city: 'Orange', terms: [] }, 100).length, DEFAULT_TERMS.length);
  assert.deepEqual(queriesFor({ city: '   ', terms: ['markets'] }), []);
});

test('a bare end date runs to the close of that day', (t) => {
  const before = process.env.TZ;
  t.after(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
  process.env.TZ = 'Australia/Sydney';
  assert.equal(parseEnd('2026-10-09'), '2026-10-09T13:00:00.000Z', 'midnight at the close of the 9th');
  assert.equal(parseEnd('2026-10-09T16:00:00+11:00'), '2026-10-09T05:00:00.000Z');
  assert.equal(parseEnd('nonsense'), undefined);
});
