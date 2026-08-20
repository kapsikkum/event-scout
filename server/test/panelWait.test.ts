import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jitter, panelWaitMs } from '../src/density/sources/googlePopular.js';
import type { Venue } from '../src/density/store.js';

const venue = (barrenStreak: number): Venue => ({
  cid: '0x0:0x0', name: 'v', kgmid: '/m/1', lat: 0, lon: 0, term: 't', barrenStreak,
});

const FULL = 13000;

test('panelWaitMs: a venue that still shows a panel keeps full patience', () => {
  assert.equal(panelWaitMs(venue(0), FULL), FULL);
  assert.equal(panelWaitMs(venue(2), FULL), FULL);
});

test('panelWaitMs: a venue with no panel is quick-checked after three misses', () => {
  assert.ok(panelWaitMs(venue(3), FULL) < FULL);
  assert.ok(panelWaitMs(venue(10), FULL) < FULL);
});

test('panelWaitMs: a barren venue is re-probed at full patience periodically', () => {
  // Without this a venue that gains popular times later would never be noticed.
  assert.equal(panelWaitMs(venue(24), FULL), FULL);
  assert.equal(panelWaitMs(venue(48), FULL), FULL);
  assert.ok(panelWaitMs(venue(25), FULL) < FULL);
});

test('panelWaitMs: a venue with no recorded streak is treated as unknown, not barren', () => {
  assert.equal(panelWaitMs({ ...venue(0), barrenStreak: undefined }, FULL), FULL);
});

test('jitter: spreads around the mean without ever stopping or doubling it', () => {
  const samples = Array.from({ length: 2000 }, () => jitter(2000));
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(Math.min(...samples) >= 1200, 'never drops below 60% of the mean');
  assert.ok(Math.max(...samples) <= 2800, 'never exceeds 140% of the mean');
  assert.ok(Math.abs(avg - 2000) < 100, `average cadence holds (got ${Math.round(avg)})`);
  assert.ok(new Set(samples).size > 100, 'actually varies rather than returning a constant');
});
