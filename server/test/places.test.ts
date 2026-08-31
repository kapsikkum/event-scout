import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignPlaces, hubsFromSettings, Hub, Placeable } from '../src/places.js';
import { isOver } from '../src/validate.js';

/**
 * Rounding events to the nearest town the user searches.
 *
 * The towns come from settings, never from a list in the code, so the Halifax
 * case below runs through exactly the same paths as the Bathurst one.
 */

const BATHURST: Hub = { name: 'Bathurst', lat: -33.4166, lng: 149.5804, radiusKm: 85 };
const PENRITH: Hub = { name: 'Penrith', lat: -33.7512, lng: 150.6941, radiusKm: 25 };
const HUBS = [BATHURST, PENRITH];

const at = (lat: number | null, lng: number | null, locality = '', address = ''): Placeable => ({
  lat,
  lng,
  locality,
  address,
});

test('an event rounds to the nearest town it is inside the radius of', () => {
  const places = assignPlaces(
    [
      at(-33.4159, 149.5556, 'Llanarth'), // a Bathurst suburb, 2 km out
      at(-33.7686, 150.6786, 'Jamisontown'), // a Penrith suburb
      at(-33.4166, 149.5804, 'Bathurst'),
    ],
    HUBS
  );
  assert.deepEqual(places, ['Bathurst', 'Penrith', 'Bathurst']);
});

test('an event with coordinates outside every town is elsewhere', () => {
  const places = assignPlaces(
    [
      at(-37.8284, 140.7807, 'Mount Gambier'), // another state
      at(-33.8688, 151.2093, 'Sydney'), // 50 km from Penrith, whose radius is 25
    ],
    HUBS
  );
  assert.deepEqual(places, ['', '']);
});

test('the towns are whichever ones the settings name', () => {
  // Nothing about this is Australian: the same code, given Nova Scotian
  // settings, rounds a Dartmouth address to Halifax.
  const hubs = hubsFromSettings({
    city: 'Halifax NS',
    lat: 44.6488,
    lng: -63.5752,
    radiusKm: 40,
    eventAreas: [{ name: 'Truro NS', lat: 45.3656, lng: -63.28 }],
  });
  assert.deepEqual(
    hubs.map((h) => h.name),
    ['Halifax', 'Truro'],
    'the region is trimmed off the label'
  );
  const places = assignPlaces([at(44.6716, -63.5768, 'Dartmouth'), at(45.3656, -63.28)], hubs);
  assert.deepEqual(places, ['Halifax', 'Truro']);
});

test('an area with no coordinates of its own is positioned by the lookup', () => {
  const hubs = hubsFromSettings(
    { city: 'Bathurst', lat: -33.4166, lng: 149.5804, radiusKm: 85, eventAreas: [{ name: 'Penrith NSW' }] },
    (name) => (name === 'Penrith NSW' ? { lat: -33.7512, lng: 150.6941 } : null)
  );
  assert.deepEqual(hubs.map((h) => h.name), ['Bathurst', 'Penrith']);
  assert.equal(assignPlaces([at(-33.7686, 150.6786)], hubs)[0], 'Penrith');
});

test('a suburb placed by coordinates places the listings that arrived without any', () => {
  // Half the listings have no position at all: the geocoder only accepts a
  // result inside a search area, so anything it could not confirm is stored
  // bare. What the placed ones know about a suburb carries to the rest.
  const places = assignPlaces(
    [at(-33.4159, 149.5556, 'Llanarth'), at(null, null, 'Llanarth'), at(null, null, 'Llanarth')],
    HUBS
  );
  assert.deepEqual(places, ['Bathurst', 'Bathurst', 'Bathurst']);
});

test('a town named in the tail of an address counts, a street that looks like one does not', () => {
  const places = assignPlaces(
    [
      at(null, null, '', 'Mountain Straight, Bathurst, NSW, 2795'),
      at(null, null, '', '12 Penrith Grove, Liverpool, NSW'),
    ],
    HUBS
  );
  assert.deepEqual(places, ['Bathurst', ''], 'the first component of an address is a street');
});

test('a city name in an address field does not file the city under a town', () => {
  // The geocoder only accepts a result inside a search area, so an address of
  // "Sydney, NSW" is stored with a position near whichever area was searched.
  // Twenty kilometres of listings pinned around Penrith is not a suburb of it.
  const spread = [
    at(-33.744, 150.665, 'Sydney'),
    at(-33.69, 150.727, 'Sydney'),
    at(-33.804, 150.869, 'Sydney'),
    at(-33.757, 150.684, 'Sydney'),
    at(null, null, 'Sydney'),
  ];
  assert.deepEqual(assignPlaces(spread, HUBS), Array(5).fill('Sydney'));
});

test('somewhere with enough events of its own is named rather than swallowed', () => {
  const sydney = Array.from({ length: 5 }, () => at(null, null, 'Sydney'));
  assert.deepEqual(assignPlaces(sydney, HUBS), Array(5).fill('Sydney'));

  const few = Array.from({ length: 4 }, () => at(null, null, 'Sydney'));
  assert.deepEqual(assignPlaces(few, HUBS), Array(4).fill(''), 'below the threshold it is just elsewhere');
});

test('a listing with no locality at all stays elsewhere', () => {
  assert.deepEqual(assignPlaces([at(null, null), at(null, null)], HUBS), ['', '']);
});

/**
 * Events that have been and gone.
 *
 * These were sitting at the top of the list for days: archiving only ran
 * inside a refresh, and the refresh had not run since a source hung.
 */

test('an event with an end time is over when that end passes', () => {
  const now = new Date('2026-08-31T12:00:00+10:00');
  assert.equal(isOver('2026-08-31T09:00:00+10:00', '2026-08-31T11:00:00+10:00', now), true);
  assert.equal(isOver('2026-08-31T09:00:00+10:00', '2026-08-31T14:00:00+10:00', now), false, 'still running');
});

test('an event with no end time lasts the day it started and no longer', () => {
  const now = new Date('2026-08-31T12:00:00+10:00');
  assert.equal(isOver('2026-08-31T10:30:00+10:00', null, now), false, 'this morning, still today');
  assert.equal(isOver('2026-08-30T10:30:00+10:00', null, now), true, 'yesterday');
  assert.equal(isOver('2026-09-01T10:30:00+10:00', null, now), false, 'tomorrow');
});

test('an unreadable date is not treated as past', () => {
  assert.equal(isOver('not a date', null, new Date('2026-08-31T12:00:00+10:00')), false);
});
