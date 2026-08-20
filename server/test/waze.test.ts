import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WazeCollector, WazeFeed, jamSeverity, userPoint } from '../src/density/sources/waze.js';
import type { Area } from '../src/density/areas.js';

/**
 * The collector is the half of the Waze integration that can be tested without
 * Waze. It takes georss responses and turns them into observations, and it does
 * not care what fetched them — so a fixture exercises exactly the code path a
 * live feed would.
 *
 * The fixture mirrors the shape the live-map endpoint returns for a Bathurst
 * viewport: jams as polylines under `line: [{x, y}]`, alerts as points under
 * `location: {x, y}`, wazers with `location` plus a speed. Coordinates are
 * x=lon, y=lat, which is the trap this parsing exists to handle.
 */
const AREA: Area = {
  name: 'Bathurst',
  slug: 'bathurst',
  bbox: { south: -33.46, west: 149.52, north: -33.37, east: 149.64 },
  cellMeters: 100,
  kernelMeters: 300,
};

/** A jam along Great Western Hwy, roughly 900 m of it. */
const FEED: WazeFeed = {
  jams: [
    {
      uuid: 'jam-1', level: 4, delay: 240, length: 900, speedKMH: 12,
      street: 'Great Western Hwy', city: 'Bathurst',
      line: [
        { x: 149.5700, y: -33.4180 },
        { x: 149.5760, y: -33.4185 },
        { x: 149.5800, y: -33.4190 },
      ],
    },
  ],
  alerts: [
    {
      uuid: 'alert-1', type: 'POLICE', subtype: 'POLICE_VISIBLE',
      reliability: 8, nThumbsUp: 3, street: 'Conrod Straight', city: 'Bathurst',
      pubMillis: 1_755_000_000_000,
      location: { x: 149.5540, y: -33.4520 },
    },
    // Sydney — well outside the area, must be dropped.
    {
      uuid: 'alert-out', type: 'ACCIDENT', reliability: 9,
      location: { x: 151.2093, y: -33.8688 },
    },
  ],
  users: [
    { uuid: 'user-moving', location: { x: 149.5775, y: -33.4193 }, speedKMH: 48 },
    { uuid: 'user-parked', location: { x: 149.5781, y: -33.4201 }, speedKMH: 0 },
    // No coordinates at all — must not throw, must not count.
    { uuid: 'user-nowhere' },
  ],
};

test('jamSeverity: closures pin to 1, delay outranks level', () => {
  assert.equal(jamSeverity({ delay: -1, level: 1 }), 1);
  assert.equal(jamSeverity({ level: 5, delay: 0 }), 1);
  // 600s of delay saturates; level 1 alone would only give 0.2.
  assert.equal(jamSeverity({ level: 1, delay: 600 }), 1);
  assert.equal(jamSeverity({}), 0);
});

test('userPoint: accepts location{x,y}, flat x/y, and m/s speed', () => {
  assert.deepEqual(userPoint({ location: { x: 149.58, y: -33.42 }, speedKMH: 20 }), {
    lat: -33.42, lon: 149.58, speedKmh: 20,
  });
  // Older shape: coordinates flat on the object, speed in m/s.
  assert.deepEqual(userPoint({ x: 149.58, y: -33.42, speed: 10 }), {
    lat: -33.42, lon: 149.58, speedKmh: 36,
  });
  assert.equal(userPoint({ uuid: 'nope' }), null);
});

test('collector: parses a georss feed into observations', () => {
  const c = new WazeCollector(AREA);
  c.add(FEED);

  assert.equal(c.jams, 1, 'one jam');
  assert.equal(c.alerts, 1, 'the Sydney alert is outside the bbox and dropped');
  assert.equal(c.users, 2, 'the wazer with no coordinates is skipped');

  // A ~900 m jam sampled every 100 m should yield roughly ten points, all of
  // them inside the bbox and all carrying the street through.
  const jamRows = c.observations.filter((o) => o.source === 'waze-jam');
  assert.ok(jamRows.length >= 8, `expected the jam densified, got ${jamRows.length} points`);
  assert.ok(jamRows.every((o) => o.lat < -33.37 && o.lat > -33.46));
  assert.ok(jamRows.every((o) => o.lon > 149.52 && o.lon < 149.64));
  assert.equal(jamRows[0].meta.street, 'Great Western Hwy');
  assert.equal(jamRows[0].kind, 'level-4');

  const police = c.observations.find((o) => o.source === 'waze-alert');
  assert.equal(police?.kind, 'POLICE_VISIBLE');
  assert.equal(police?.lat, -33.4520, 'y is latitude');
  assert.equal(police?.lon, 149.5540, 'x is longitude');
  // POLICE weighs 0.4, reliability 8 -> trust 0.9.
  assert.ok(Math.abs((police?.weight ?? 0) - 0.36) < 1e-9);

  // The parked wazer should outweigh the moving one.
  const rows = c.observations.filter((o) => o.source === 'waze-users');
  assert.equal(rows.length, 2);
  const [heavier, lighter] = [...rows].sort((a, b) => b.weight - a.weight);
  assert.ok(heavier.weight > lighter.weight, 'a stationary wazer counts for more');
});

test('collector: de-duplicates across overlapping responses', () => {
  const c = new WazeCollector(AREA);
  const first = c.add(FEED);
  // Tiles overlap at their seams and a panning map refetches ground it has
  // already covered, so the same feed arriving twice must add nothing.
  const second = c.add(FEED);

  assert.ok(first > 0, 'the first response produced rows');
  assert.equal(second, 0, 'the repeat produced none');
  assert.equal(c.jams, 1);
  assert.equal(c.alerts, 1);
  assert.equal(c.users, 2);
});
