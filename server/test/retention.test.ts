import { test } from 'node:test';
import assert from 'node:assert/strict';

// A tiny pure re-statement of the cutoff, imported for its own sake: the SQL
// around it needs a database, but the arithmetic is where the mistake would be.
import { OBSERVATION_RETENTION_DAYS, retentionCutoff } from '../src/density/store.js';

/**
 * The units. Every timestamp in the density tables is seconds and `Date.now()`
 * is milliseconds, which is the one confusion in this codebase that has already
 * produced a wrong answer once. A cutoff computed in the wrong unit would be a
 * thousand times too large and take the whole table with it.
 */
test('the cutoff is in the seconds the table stores, not milliseconds', () => {
  const now = Date.UTC(2026, 8, 9, 12, 0, 0);
  const cutoff = retentionCutoff(now);
  assert.equal(cutoff, Math.floor(now / 1000) - 365 * 86400);
  // A year earlier, read back as a date, is a year earlier.
  assert.equal(new Date(cutoff * 1000).getUTCFullYear(), 2025);
  assert.ok(cutoff < now / 1000, 'the cutoff is in the past');
  assert.ok(cutoff > 1_000_000_000, 'and is a plausible epoch-seconds value');
});

/**
 * The property that matters in practice: three weeks of samples, which is what
 * the live instance holds, must all survive.
 */
test('recent samples are never inside the cutoff', () => {
  const now = Date.now();
  const cutoff = retentionCutoff(now);
  for (const daysAgo of [0, 1, 14, 22, 90, 364]) {
    const ts = Math.floor(now / 1000) - daysAgo * 86400;
    assert.ok(ts >= cutoff, `a sample ${daysAgo} days old should be kept`);
  }
  const tooOld = Math.floor(now / 1000) - (OBSERVATION_RETENTION_DAYS + 1) * 86400;
  assert.ok(tooOld < cutoff, 'and one past the window should not be');
});
