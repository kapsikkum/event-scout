import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localitiesFrom, unifyVenueNames, venueKey } from '../src/venues.js';

/**
 * Mount Panorama, as it actually arrived: seven spellings, positions up to
 * 3 km apart, and a hotel of nearly the same name that must not be folded in
 * with them.
 */
const PANORAMA = [
  { name: 'Mount Panorama Circuit', count: 5 },
  { name: 'Mount Panorama', count: 4 },
  { name: 'Mount Panorama Bathurst', count: 2 },
  { name: 'Mount Panorama, Bathurst', count: 2 },
  { name: 'Panorama Bathurst', count: 2 },
  { name: 'Mount Panorama Motor Racing Circuit', count: 1 },
  { name: 'Mount Panorama Racing Circuit, Bathurst, NSW, Australia', count: 1 },
  { name: 'Rydges Mount Panorama', count: 1 },
];
const LOCALITIES = ['Bathurst', 'Orange NSW', 'Penrith NSW'];

test('the distinguishing words survive and the descriptive ones do not', () => {
  assert.deepEqual(venueKey('Mount Panorama Motor Racing Circuit'), ['panorama']);
  assert.deepEqual(venueKey('Mount Panorama Racing Circuit, Bathurst, NSW, Australia'), ['panorama']);
  assert.deepEqual(venueKey('Bathurst Memorial Entertainment Centre - BMEC'), ['bathurst', 'centre', 'entertainment', 'memorial']);
  assert.deepEqual(venueKey('Orange Showground s/s'), ['orange', 'showground']);
});

test('every spelling of the circuit collapses onto the most used one', () => {
  const map = unifyVenueNames(PANORAMA, LOCALITIES);
  for (const name of ['Mount Panorama', 'Mount Panorama Bathurst', 'Panorama Bathurst', 'Mount Panorama, Bathurst', 'Mount Panorama Motor Racing Circuit']) {
    assert.equal(map.get(name), 'Mount Panorama Circuit', name);
  }
});

test('the hotel across the valley keeps its own name', () => {
  assert.equal(unifyVenueNames(PANORAMA, LOCALITIES).get('Rydges Mount Panorama'), undefined);
});

test('two towns sharing a venue type stay apart', () => {
  const map = unifyVenueNames(
    [
      { name: 'Bathurst RSL Club', count: 4 },
      { name: 'Penrith RSL Club', count: 2 },
      { name: 'Penrith RSL', count: 1 },
      { name: 'Bathurst Showground', count: 3 },
      { name: 'Orange Showground', count: 1 },
      { name: 'Orange Showground s/s', count: 1 },
    ],
    LOCALITIES
  );
  assert.equal(map.get('Penrith RSL'), 'Penrith RSL Club');
  assert.equal(map.get('Orange Showground s/s'), 'Orange Showground');
  assert.equal(map.get('Bathurst RSL Club'), undefined);
  assert.equal(map.get('Bathurst Showground'), undefined);
  assert.equal(map.get('Orange Showground'), undefined);
});

test('an acronym tacked on after a dash is the same venue', () => {
  const map = unifyVenueNames(
    [
      { name: 'Bathurst Memorial Entertainment Centre', count: 3 },
      { name: 'Bathurst Memorial Entertainment Centre - BMEC', count: 1 },
    ],
    LOCALITIES
  );
  assert.equal(map.get('Bathurst Memorial Entertainment Centre - BMEC'), 'Bathurst Memorial Entertainment Centre');
});

test('a venue named only once is left exactly as it is', () => {
  assert.equal(unifyVenueNames([{ name: 'Archie Brother\'s', count: 1 }], LOCALITIES).size, 0);
});

test('localities come from the searched areas and from the addresses themselves', () => {
  const found = localitiesFrom(['Bathurst', 'Penrith NSW'], [
    '1 Short St, Kelso, NSW, 2795',
    '2 Long St, Kelso, NSW, 2795',
    '3 Wide St, Kelso, NSW, 2795',
  ]);
  assert.ok(found.has('bathurst'));
  assert.ok(found.has('penrith'));
  assert.ok(found.has('kelso'), 'a suburb seen three times is a locality');
  assert.ok(!found.has('nsw'), 'the state is not a locality');
});
