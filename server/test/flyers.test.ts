import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extensionFor,
  FlyerStore,
  flyerDay,
  flyerHref,
  flyerName,
  flyerRelative,
  FLYER_EXTENSIONS,
  isSafeFlyerPath,
} from '../src/flyers.js';

test('only believable image types are stored, and each gets one extension', () => {
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('image/jpeg; charset=binary'), 'jpg');
  assert.equal(extensionFor('IMAGE/PNG'), 'png');
  assert.equal(extensionFor('image/webp'), 'webp');
  // AVIF because allevents' CDN serves it, and a fifth of what was on offer was
  // being refused as "not an image".
  assert.equal(extensionFor('image/avif'), 'avif');
  assert.equal(extensionFor('image/gif'), 'gif');
  // SVG is markup, and markup served back from this app's own origin is a
  // script it would be running on itself.
  for (const type of ['text/html', 'image/svg+xml', 'application/pdf', 'application/octet-stream', '']) {
    assert.equal(extensionFor(type), null, type);
  }
});

/**
 * The same address must always land on the same file: two events often share a
 * picture, and re-fetching one already held would be the whole point missed.
 */
test('a name follows the address, and nothing else', () => {
  const url = 'https://images.midnightspec.com/full/DdA5yrvilBW.jpg';
  assert.equal(flyerName(url, 'jpg'), flyerName(url, 'jpg'));
  assert.notEqual(flyerName(url, 'jpg'), flyerName(url + '?v=2', 'jpg'));
  assert.match(flyerName(url, 'jpg'), /^[0-9a-f]{16}\.jpg$/);
});

/**
 * Filed by the local date, not the stored UTC one. A quarter of this database
 * starts in the morning, which UTC puts on the previous day — the same
 * confusion that had the deduper bucketing events wrong.
 */
test('an event is filed under the day it happens locally', (t) => {
  // The zone is named, not inherited: a runner in UTC would otherwise show the
  // bug rather than the fix. Restored afterwards so nothing else inherits it.
  const before = process.env.TZ;
  t.after(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
  process.env.TZ = 'Australia/Sydney';

  assert.equal(flyerDay('2026-10-07T23:00:00.000Z'), '2026-10-08', 'a 10am event is not on the 7th');
  assert.equal(flyerDay('2026-10-08T00:00:00.000Z'), '2026-10-08');
  assert.equal(flyerDay('not a date'), 'undated');
});

/**
 * Both halves reach the route straight out of a URL, so they are checked
 * rather than trusted.
 */
test('a path that this app did not write is refused', () => {
  assert.ok(isSafeFlyerPath('2026-10-08', 'abcdef0123456789.jpg'));
  assert.ok(isSafeFlyerPath('undated', 'abcdef0123456789.webp'));
  // Every type the store can write must be servable, or a stored copy 404s.
  for (const ext of FLYER_EXTENSIONS) {
    assert.ok(isSafeFlyerPath('2026-10-08', `abcdef0123456789.${ext}`), ext);
  }
  for (const [day, name] of [
    ['..', 'abcdef0123456789.jpg'],
    ['2026-10-08', '../../etc/passwd'],
    ['2026-10-08', 'abcdef0123456789.jpg/../../x'],
    ['../2026-10-08', 'abcdef0123456789.jpg'],
    ['2026-10-08', '.env'],
    ['2026-10-08', 'event-scout.db'],
    ['2026-10-08', 'ABCDEF0123456789.jpg'],
    ['2026-10-08', 'abcdef0123456789.svg'],
    // The separator has to be a real dot: written as an unescaped one in the
    // pattern it matched any character, and this slipped through.
    ['2026-10-08', 'abcdef0123456789Xjpg'],
    ['2026-10-08', 'abcdef0123456789/jpg'],
    ['2026-10-8', 'abcdef0123456789.jpg'],
    ['', ''],
  ] as const) {
    assert.equal(isSafeFlyerPath(day, name), false, `${day}/${name}`);
  }
});

test('the served address is escaped, and points at the route', () => {
  assert.equal(flyerHref('2026-10-08/abcdef0123456789.jpg'), '/api/flyer/2026-10-08/abcdef0123456789.jpg');
});

// --- the store on disk ------------------------------------------------------

function tempStore(): FlyerStore {
  return new FlyerStore(fs.mkdtempSync(path.join(os.tmpdir(), 'flyers-')));
}

test('a copy is written, found and removed', () => {
  const store = tempStore();
  const rel = flyerRelative('2026-10-08', 'abcdef0123456789.jpg');
  assert.equal(store.has(rel), false);
  store.write(rel, Buffer.from('not really a jpeg'));
  assert.equal(store.has(rel), true);
  assert.deepEqual(store.list(), [rel]);
  assert.ok(store.bytes() > 0);
  assert.equal(store.remove(rel), true);
  assert.equal(store.remove(rel), false, 'removing twice is not an error');
});

/** Nothing half-written is ever visible: it lands under .part and is renamed. */
test('a partial download is never listed', () => {
  const store = tempStore();
  const rel = flyerRelative('2026-10-08', 'abcdef0123456789.jpg');
  store.write(rel, Buffer.from('x'));
  fs.writeFileSync(store.absolute(rel) + '.part', 'half a file');
  assert.deepEqual(store.list(), [rel], 'the .part is not offered');
});

/** The reason the folder is worth re-filing: an event's date can change. */
test('a copy follows its event when the date moves', () => {
  const store = tempStore();
  const name = 'abcdef0123456789.jpg';
  const from = flyerRelative('2026-10-07', name);
  const to = flyerRelative('2026-10-08', name);
  store.write(from, Buffer.from('flyer'));

  assert.equal(store.refile(from, to), true);
  assert.equal(store.has(from), false);
  assert.equal(store.has(to), true);
  assert.equal(store.refile(to, to), false, 'already where it belongs');
  assert.equal(store.refile(from, to), false, 'nothing left to move');
});

/** Two listings can share a picture and disagree about the date. */
test('re-filing onto a copy that is already there keeps one of them', () => {
  const store = tempStore();
  const name = 'abcdef0123456789.jpg';
  const from = flyerRelative('2026-10-07', name);
  const to = flyerRelative('2026-10-08', name);
  store.write(from, Buffer.from('a'));
  store.write(to, Buffer.from('b'));
  assert.equal(store.refile(from, to), true);
  assert.equal(store.has(from), false);
  assert.equal(store.has(to), true);
});

test('emptied day folders are cleared away', () => {
  const store = tempStore();
  const rel = flyerRelative('2026-10-08', 'abcdef0123456789.jpg');
  store.write(rel, Buffer.from('x'));
  store.remove(rel);
  store.tidy();
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(store.absolute('2026-10-08')), false);
});

test('an empty store answers rather than throwing', () => {
  const store = new FlyerStore(path.join(os.tmpdir(), 'flyers-does-not-exist-' + Date.now()));
  assert.deepEqual(store.list(), []);
  assert.equal(store.bytes(), 0);
  store.tidy();
});
