import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  FREE_ATTEMPTS,
  LOCKOUT_MS,
  MAX_ATTEMPTS,
  loginBlockedFor,
  newSessionToken,
  noteLoginFailure,
  noteLoginSuccess,
  pruneAttempts,
  sessionValid,
  setPassword,
  _resetAttemptsForTest,
  _attemptsCountForTest,
} from '../src/authStore.js';

beforeEach(() => {
  _resetAttemptsForTest();
});

test('changing the password invalidates outstanding sessions', () => {
  setPassword('old-password');
  const { token } = newSessionToken();
  assert.equal(sessionValid(token), true);
  setPassword('new-password');
  assert.equal(sessionValid(token), false);
  setPassword(''); // leave no password behind for other tests
});

test('5 failed attempts are permitted before lockout', () => {
  const t0 = 100_000;
  const ip = '192.168.1.1';
  for (let i = 1; i <= 5; i++) {
    noteLoginFailure(ip, t0 + i * 100);
    assert.equal(loginBlockedFor(ip, t0 + i * 100), 0, `Attempt ${i} should not be blocked`);
  }
});

test('6th attempt locks out for 30 seconds', () => {
  const t0 = 100_000;
  const ip = '192.168.1.1';
  for (let i = 1; i <= 5; i++) {
    noteLoginFailure(ip, t0 + i * 100);
  }
  const t6 = t0 + 600;
  noteLoginFailure(ip, t6);
  assert.equal(loginBlockedFor(ip, t6), LOCKOUT_MS);
  assert.equal(loginBlockedFor(ip, t6 + 10_000), 20_000);
  assert.equal(loginBlockedFor(ip, t6 + LOCKOUT_MS), 0);
});

test('after lockout period elapses, the next failure does not immediately re-lock (count was reset)', () => {
  const t0 = 100_000;
  const ip = '192.168.1.1';
  for (let i = 1; i <= 6; i++) {
    noteLoginFailure(ip, t0 + i * 100);
  }
  const lockoutUntil = t0 + 600 + LOCKOUT_MS;
  assert.equal(loginBlockedFor(ip, lockoutUntil), 0);

  // 1st failure after lockout expires - must NOT lock out
  const nextFailureTime = lockoutUntil + 1;
  noteLoginFailure(ip, nextFailureTime);
  assert.equal(loginBlockedFor(ip, nextFailureTime), 0, 'First failure after lockout should not re-lock');

  // Should allow 4 more failures (total 5) before locking out again on the 6th
  for (let i = 2; i <= 5; i++) {
    noteLoginFailure(ip, nextFailureTime + i * 100);
    assert.equal(loginBlockedFor(ip, nextFailureTime + i * 100), 0, `Attempt ${i} after reset should not be blocked`);
  }

  // 6th failure post-lockout locks out again
  const relockTime = nextFailureTime + 600;
  noteLoginFailure(ip, relockTime);
  assert.equal(loginBlockedFor(ip, relockTime), LOCKOUT_MS);
});

test('failure count resets if user pauses longer than LOCKOUT_MS between attempts', () => {
  const t0 = 100_000;
  const ip = '192.168.1.1';
  // 3 failed attempts
  for (let i = 1; i <= 3; i++) {
    noteLoginFailure(ip, t0 + i * 100);
  }
  // Pause for 35 seconds (> LOCKOUT_MS = 30s)
  const tPause = t0 + 300 + 35_000;
  // Next failure should reset count to 1 (not 4)
  noteLoginFailure(ip, tPause);
  assert.equal(loginBlockedFor(ip, tPause), 0);

  // Can fail 4 more times before locking out
  for (let i = 2; i <= 5; i++) {
    noteLoginFailure(ip, tPause + i * 100);
    assert.equal(loginBlockedFor(ip, tPause + i * 100), 0);
  }
  // 6th locks out
  noteLoginFailure(ip, tPause + 600);
  assert.equal(loginBlockedFor(ip, tPause + 600), LOCKOUT_MS);
});

test('success clears attempts', () => {
  const t0 = 100_000;
  const ip = '192.168.1.1';
  for (let i = 1; i <= 6; i++) {
    noteLoginFailure(ip, t0 + i * 100);
  }
  assert.equal(loginBlockedFor(ip, t0 + 600), LOCKOUT_MS);
  assert.equal(_attemptsCountForTest(), 1);

  noteLoginSuccess(ip);
  assert.equal(loginBlockedFor(ip, t0 + 600), 0);
  assert.equal(_attemptsCountForTest(), 0);
});

test('expired entries are pruned', () => {
  const t0 = 100_000;
  const ip1 = '192.168.1.1';
  const ip2 = '192.168.1.2';
  const ip3 = '192.168.1.3';

  // ip1 fails once at t0
  noteLoginFailure(ip1, t0);
  // ip2 fails 6 times at t0 (locked out until t0 + 30_000)
  for (let i = 0; i < 6; i++) {
    noteLoginFailure(ip2, t0);
  }

  assert.equal(_attemptsCountForTest(), 2);

  // At t0 + 50_000 (< LOCKOUT_MS * 2 = 60_000), neither is older than 60s
  pruneAttempts(t0 + 50_000);
  assert.equal(_attemptsCountForTest(), 2);

  // At t0 + 60_001 (> LOCKOUT_MS * 2), ip1 and ip2 are both older than 60s, and ip2 lockout expired
  // ip3 logs in at t0 + 60_001, triggering automatic prune in noteLoginFailure
  noteLoginFailure(ip3, t0 + 60_001);

  assert.equal(_attemptsCountForTest(), 1);
  // Only ip3 remains
  assert.equal(loginBlockedFor(ip1, t0 + 60_001), 0);
  assert.equal(loginBlockedFor(ip2, t0 + 60_001), 0);
  assert.equal(loginBlockedFor(ip3, t0 + 60_001), 0);
});

test('locked-out entry is not pruned prematurely before lockout expires', () => {
  const t0 = 100_000;
  const ip = '192.168.1.1';
  for (let i = 0; i < 6; i++) {
    noteLoginFailure(ip, t0);
  }
  // Lockout ends at t0 + 30_000
  // Test prune at t0 + 20_000 (still locked out)
  pruneAttempts(t0 + 20_000);
  assert.equal(_attemptsCountForTest(), 1);
  assert.equal(loginBlockedFor(ip, t0 + 20_000), 10_000);
});

test('capacity cap evicts oldest entries when map size reaches MAX_ATTEMPTS', () => {
  const t0 = 100_000;
  for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
    noteLoginFailure(`ip-${i}`, t0);
  }
  assert.equal(_attemptsCountForTest(), MAX_ATTEMPTS);
});
