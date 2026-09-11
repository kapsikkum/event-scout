import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEnd, parseWhen } from '../src/when.js';
import { useZone } from './zone.js';

/**
 * The line that put an invented 11:00 am on 135 of 386 listings: a bare date
 * handed to `new Date` is UTC midnight, which is mid-morning here.
 */
test('a bare date is local midnight, and says it has no time', (t) => {
  useZone(t, 'Australia/Sydney');
  assert.deepEqual(parseWhen('2026-10-08'), { startTime: '2026-10-07T13:00:00.000Z', dateOnly: true });
});

test('a stated time is kept as stated', (t) => {
  useZone(t, 'Australia/Sydney');
  assert.deepEqual(parseWhen('2026-10-08T10:00:00+11:00'), { startTime: '2026-10-07T23:00:00.000Z', dateOnly: false });
  assert.deepEqual(parseWhen('2026-10-08T10:00:00'), { startTime: '2026-10-07T23:00:00.000Z', dateOnly: false });
});

/** new Date(2026, 12, 45) is not an error, it is February 2027. */
test('a date that rolls over is refused, not moved', () => {
  for (const junk of ['2026-13-45', '2026-02-30', '2026-00-10', '', 'TBA']) {
    assert.equal(parseWhen(junk), null, junk);
  }
});

test('a bare end date runs to the close of that day', (t) => {
  useZone(t, 'Australia/Sydney');
  assert.equal(parseEnd('2026-10-09'), '2026-10-09T13:00:00.000Z', 'midnight at the close of the 9th');
  assert.equal(parseEnd('2026-10-09T16:00:00+11:00'), '2026-10-09T05:00:00.000Z');
  assert.equal(parseEnd('2026-02-30'), undefined);
  assert.equal(parseEnd(undefined), undefined);
});
