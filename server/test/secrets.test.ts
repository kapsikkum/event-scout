import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSecrets, redactSettings, resolveSecret, SECRET_KEYS } from '../src/secrets.js';
import { DEFAULT_SETTINGS, Settings } from '../src/sources/types.js';

const stored: Settings = {
  ...DEFAULT_SETTINGS,
  city: 'Bathurst',
  ticketmasterKey: 'tm-real-key',
  seatgeekClientId: 'sg-real-id',
  eventbriteToken: 'eb-real-token',
  fbCookie: 'c_user=123; xs=abc',
};

test('no credential survives the trip out', () => {
  const sent = redactSettings(stored);
  for (const key of SECRET_KEYS) {
    assert.equal(sent[key], '', `${key} should be blank`);
  }
  // And nothing of the value is left anywhere else in the response.
  const body = JSON.stringify(sent);
  for (const secret of ['tm-real-key', 'sg-real-id', 'eb-real-token', 'c_user=123', 'xs=abc']) {
    assert.ok(!body.includes(secret), `${secret} leaked`);
  }
});

test('everything that is not a credential is sent as it was', () => {
  const sent = redactSettings(stored);
  assert.equal(sent.city, 'Bathurst');
  assert.deepEqual(sent.eventbriteOrganizerIds, stored.eventbriteOrganizerIds);
});

test('the page is told which are set, without being told what to', () => {
  assert.deepEqual(redactSettings(stored).secretsSet, {
    ticketmasterKey: true,
    seatgeekClientId: true,
    eventbriteToken: true,
    fbCookie: true,
  });
  assert.deepEqual(redactSettings({ ...stored, fbCookie: '', ticketmasterKey: '   ' }).secretsSet, {
    ticketmasterKey: false,
    seatgeekClientId: true,
    eventbriteToken: true,
    fbCookie: false,
  });
});

/**
 * The rule the whole design turns on. The settings page PUTs back the object it
 * was handed, and what it was handed has the credentials blanked — so if empty
 * meant "clear", every save would wipe every key.
 */
test('a blank credential leaves the stored one alone', () => {
  assert.equal(resolveSecret('tm-real-key', ''), 'tm-real-key');
  assert.equal(resolveSecret('tm-real-key', '   '), 'tm-real-key');
  assert.equal(resolveSecret('tm-real-key', undefined), 'tm-real-key');
});

test('a round trip through the page changes nothing', () => {
  const sent = redactSettings(stored);
  // Exactly what the page sends back: the object it was given, unedited.
  const merged = mergeSecrets(stored, JSON.parse(JSON.stringify(sent)));
  for (const key of SECRET_KEYS) {
    assert.equal(merged[key], stored[key], `${key} should have survived the round trip`);
  }
});

test('a new value replaces, and is trimmed', () => {
  assert.equal(resolveSecret('old', 'new-key'), 'new-key');
  assert.equal(resolveSecret('old', '  new-key  '), 'new-key');
  assert.equal(resolveSecret('', 'first-key'), 'first-key');
});

/**
 * Null, because it is the one thing a text input cannot produce by accident —
 * an empty box yields "", never null. Clearing has to be asked for on purpose.
 */
test('null is how a credential is removed', () => {
  assert.equal(resolveSecret('tm-real-key', null), '');
  const merged = mergeSecrets(stored, { fbCookie: null });
  assert.equal(merged.fbCookie, '');
  assert.equal(merged.ticketmasterKey, 'tm-real-key', 'and only the one asked for');
});

test('junk in place of a credential leaves it alone rather than clearing it', () => {
  for (const junk of [7, [], {}, true]) {
    assert.equal(resolveSecret('tm-real-key', junk), 'tm-real-key', `${JSON.stringify(junk)}`);
  }
});
