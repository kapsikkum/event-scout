import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getKv, setKv } from '../src/db.js';
import { cachedGeocode, isGeocodeCached } from '../src/geocode.js';

const key = (query: string): string => `geocode:${query.toLowerCase().trim()}`;

test('a cached answer with no kind field is read back as stale', () => {
  const query = `geocode-test-old-format-${Date.now()}`;
  // The old raw-array format, from before `kind` and the timestamp existed.
  setKv(key(query), JSON.stringify([{ displayName: 'Somewhere', lat: 1, lng: 2 }]));
  assert.equal(isGeocodeCached(query), false, 'no kind field: stale, refetch');
  assert.deepEqual(cachedGeocode(query), [{ displayName: 'Somewhere', lat: 1, lng: 2 }], 'still readable, though');
});

test('an empty answer expires sooner than a real one', () => {
  const emptyQuery = `geocode-test-empty-${Date.now()}`;
  const realQuery = `geocode-test-real-${Date.now()}`;
  const eightDaysAgo = Date.now() - 8 * 24 * 3600_000;
  setKv(key(emptyQuery), JSON.stringify({ at: eightDaysAgo, results: [] }));
  setKv(key(realQuery), JSON.stringify({ at: eightDaysAgo, results: [{ displayName: 'A Town', lat: 1, lng: 2, kind: 'place:town' }] }));
  assert.equal(isGeocodeCached(emptyQuery), false, 'empty results are stale after a week');
  assert.equal(isGeocodeCached(realQuery), true, 'a real answer is still good after a week');
});

test('a fresh answer with a kind is trusted', () => {
  const query = `geocode-test-fresh-${Date.now()}`;
  setKv(key(query), JSON.stringify({ at: Date.now(), results: [{ displayName: 'A Town', lat: 1, lng: 2, kind: 'place:town' }] }));
  assert.equal(isGeocodeCached(query), true);
});

test('an unasked query is not cached', () => {
  assert.equal(isGeocodeCached(`geocode-test-never-asked-${Date.now()}`), false);
  assert.equal(cachedGeocode(`geocode-test-never-asked-${Date.now()}`), null);
});
