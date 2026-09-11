import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignDedupeGroups } from '../src/dedupe.js';
import { useZone } from './zone.js';

/**
 * One event, listed once with its time and once with only its date. On the
 * UTC day those land a day apart — 11am AEDT is 00:00 UTC on the 8th, and a
 * bare date for the 8th is local midnight, 13:00 UTC on the 7th — so the two
 * were never compared, and the event showed twice.
 */
test('a timed listing and a date-only one for the same local day are one event', (t) => {
  useZone(t, 'Australia/Sydney');
  const groups = assignDedupeGroups([
    { id: 1, title: 'Spring Fair', startTime: '2026-10-07T13:00:00.000Z', lat: null, lng: null },
    { id: 2, title: 'Spring Fair', startTime: '2026-10-08T00:00:00.000Z', lat: null, lng: null },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

test('the same title on different local days stays apart', (t) => {
  useZone(t, 'Australia/Sydney');
  const groups = assignDedupeGroups([
    { id: 1, title: 'Night Markets', startTime: '2026-10-07T13:00:00.000Z', lat: null, lng: null },
    { id: 2, title: 'Night Markets', startTime: '2026-10-08T13:00:00.000Z', lat: null, lng: null },
  ]);
  assert.notEqual(groups.get(1), groups.get(2));
});
