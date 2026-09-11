import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractEventsFromHtml } from '../src/sources/jsonld.js';
import { useZone } from './zone.js';

const page = (startDate: string, endDate?: string): string =>
  `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Event',
    name: 'Spring Fair',
    startDate,
    ...(endDate ? { endDate } : {}),
  })}</script>`;

/**
 * Web search and MIDNIGHT_SPEC both read listings through here, and a page
 * that published only a date used to come out as UTC midnight — 11am here.
 */
test('a listing that gives only a date is kept as that day, with no time', (t) => {
  useZone(t, 'Australia/Sydney');
  const [ev] = extractEventsFromHtml(page('2026-10-08', '2026-10-09'), 'https://example.com/fair');
  assert.equal(ev.startTime, '2026-10-07T13:00:00.000Z', 'local midnight, not 11am');
  assert.equal(ev.dateOnly, true);
  assert.equal(ev.endTime, '2026-10-09T13:00:00.000Z', 'through the whole of the 9th');
});

test('a listing that gives a time keeps it', (t) => {
  useZone(t, 'Australia/Sydney');
  const [ev] = extractEventsFromHtml(page('2026-10-08T10:00:00+11:00'), 'https://example.com/fair');
  assert.equal(ev.startTime, '2026-10-07T23:00:00.000Z');
  assert.equal(ev.dateOnly, false);
});

test('a date that does not exist drops the listing rather than moving it', () => {
  assert.deepEqual(extractEventsFromHtml(page('2026-02-30'), 'https://example.com/fair'), []);
});
