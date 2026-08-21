import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bestWindow, crowdScore, lightBands, shootScore } from '../src/density/shootScore.js';

/**
 * The scoring is a judgement, not a measurement, so what is worth asserting is
 * the shape of it: that it peaks in the middle rather than at the top, and that
 * the modifiers cannot swamp the thing they modify.
 */

test('peaks in the middle, not at the extremes', () => {
  const dead = crowdScore(0);
  const sweet = crowdScore(65);
  const packed = crowdScore(100);
  assert.ok(sweet > packed, 'a packed venue is worse than a busy one');
  assert.ok(sweet > dead, 'a busy venue is better than an empty one');
  assert.ok(packed > dead, 'packed still beats nothing to photograph');
});

test('rises then falls, with no kinks either way', () => {
  const at = (p: number) => crowdScore(p);
  for (let p = 0; p < 68; p++) {
    assert.ok(at(p + 1) >= at(p), `should not dip while rising, at ${p}%`);
  }
  for (let p = 68; p < 100; p++) {
    assert.ok(at(p + 1) <= at(p), `should not rise while falling, at ${p}%`);
  }
});

test('stays inside 0..1 whatever the modifiers do', () => {
  const surging = shootScore({ busy: 68, typical: 5, light: 'golden' });
  assert.ok(surging.score <= 1, `got ${surging.score}`);
  const awful = shootScore({ busy: 0, typical: 90, light: 'night' });
  assert.ok(awful.score >= 0, `got ${awful.score}`);
});

test('busier than usual scores above the same busyness that is normal', () => {
  const surge = shootScore({ busy: 60, typical: 20 });
  const normal = shootScore({ busy: 60, typical: 60 });
  assert.ok(surge.score > normal.score);
  assert.equal(surge.surge, true);
  assert.match(surge.why, /busier than usual/);
});

test('a surge at a dead venue is not talked up', () => {
  // Twice as busy as normal, where normal is nearly nobody, is still nearly
  // nobody -- the multiplier must not rescue it.
  const v = shootScore({ busy: 8, typical: 3 });
  assert.ok(v.score < 0.42, `${v.score} should not reach Fair`);
  assert.ok(v.label === 'Dead' || v.label === 'Quiet');
});

test('golden hour lifts a slightly quieter place over a busier one at midday', () => {
  // Light is a modifier and not the whole story: it is worth about ten points
  // of busyness, enough to break a near-tie and not enough to send you to an
  // empty car park because the sky is nice.
  const golden = shootScore({ busy: 50, light: 'golden' });
  const midday = shootScore({ busy: 58, light: 'day' });
  assert.ok(golden.score > midday.score, `${golden.score} vs ${midday.score}`);

  const goldenButDead = shootScore({ busy: 10, light: 'golden' });
  const busyMidday = shootScore({ busy: 60, light: 'day' });
  assert.ok(goldenButDead.score < busyMidday.score);
});

test('no reading is Unknown rather than zero-and-Dead', () => {
  const v = shootScore({ busy: null });
  assert.equal(v.label, 'Unknown');
  assert.equal(v.why, 'no reading');
});

test('the best window spans the neighbouring hours, not one spike', () => {
  const hours = { 8: 20, 9: 55, 10: 66, 11: 68, 12: 64, 13: 30, 14: 10 };
  const w = bestWindow(hours);
  assert.ok(w);
  // 11:00 is the peak, but 9:00 through 12:00 are all within a whisker of it,
  // and a photographer planning a trip wants the stretch, not the minute.
  assert.equal(w.from, 9);
  assert.equal(w.to, 12);
  // The shoulders are genuinely worse and stay out of it.
  assert.ok(!(w.from <= 8), 'a quiet 8:00 should not be swept in');
});

test('a dead day has no window worth naming', () => {
  assert.equal(bestWindow({ 8: 0, 9: 2, 10: 1 }), null);
});

test('light bands follow the sun rather than the clock', () => {
  const band = lightBands({
    date: '2026-08-21',
    sunrise: '2026-08-21T06:30:00+10:00',
    sunset: '2026-08-21T17:40:00+10:00',
    solarNoon: null,
    dayLength: null,
    goldenMorning: { start: '2026-08-21T06:30:00+10:00', end: '2026-08-21T07:10:00+10:00' },
    goldenEvening: { start: '2026-08-21T17:00:00+10:00', end: '2026-08-21T17:40:00+10:00' },
    blueMorning: { start: '2026-08-21T06:00:00+10:00', end: '2026-08-21T06:30:00+10:00' },
    blueEvening: { start: '2026-08-21T17:40:00+10:00', end: '2026-08-21T18:10:00+10:00' },
  });
  // Asserted in the machine's own timezone, since that is what the chart draws.
  const hourOf = (iso: string) => new Date(iso).getHours();
  assert.equal(band(hourOf('2026-08-21T12:00:00+10:00')), 'day');
  assert.equal(band(hourOf('2026-08-21T02:00:00+10:00')), 'night');
  assert.equal(band(hourOf('2026-08-21T17:10:00+10:00')), 'golden');
});
