import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Cullable, cullReason } from '../src/cull.js';

const bathurst = { name: 'Bathurst', lat: -33.4166, lng: 149.5804, radiusKm: 85 };
const penrith = { name: 'Penrith', lat: -33.751, lng: 150.694, radiusKm: 25 };
const hubs = [bathurst, penrith];
const ON = { cullOutsideAreas: true, excludedCategories: ['Music'] };

function ev(over: Partial<Cullable> = {}): Cullable {
  return {
    lat: null, lng: null, locality: '', place: '', category: 'Motorsport',
    starred: false, unknownLocation: false, sources: [{ source: 'crawler' }], edited: [],
    ...over,
  };
}

// Melbourne: a long way from both.
const melbourne = { lat: -37.8136, lng: 144.9631 };

test('an event far outside every area is culled, and says how far', () => {
  assert.match(cullReason(ev(melbourne), hubs, ON) ?? '', /^\d+ km from Bathurst, the nearest area$/);
});

test('nothing is culled for distance with the setting off', () => {
  assert.equal(cullReason(ev(melbourne), hubs, { cullOutsideAreas: false }), null);
});

test('just over a radius is still in the area', () => {
  // About 100 km west of Bathurst: over 85, under 85 x 1.5.
  assert.equal(cullReason(ev({ lat: -33.42, lng: 148.5 }), hubs, ON), null);
});

test('an event that rounds to one of the towns is in it', () => {
  assert.equal(cullReason(ev({ ...melbourne, place: 'Bathurst' }), hubs, ON), null);
});

test('a town with no coordinates of its own is placed by its last lookup', () => {
  const where = (name: string) => (name === 'Geelong' ? [{ lat: -38.15, lng: 144.36 }] : []);
  assert.ok(cullReason(ev({ locality: 'Geelong' }), hubs, ON, where));
  assert.equal(cullReason(ev({ locality: 'Nowhere' }), hubs, ON, where), null, 'never looked up: left alone');
});

test('a town name that also exists inside an area is given the benefit of it', () => {
  // Kelso, Scotland first, as Nominatim may well rank it; Kelso NSW second.
  const kelso = () => [{ lat: 55.598, lng: -2.433 }, { lat: -33.418, lng: 149.614 }];
  assert.equal(cullReason(ev({ locality: 'Kelso' }), hubs, ON, kelso), null);
});

test('an event with no place at all is never culled for distance', () => {
  assert.equal(cullReason(ev({ unknownLocation: true }), hubs, ON), null);
});

test('starred and hand-added events are never culled', () => {
  assert.equal(cullReason(ev({ ...melbourne, starred: true }), hubs, ON), null);
  assert.equal(cullReason(ev({ ...melbourne, sources: [{ source: 'manual' }] }), hubs, ON), null);
  assert.equal(cullReason(ev({ category: 'Music', starred: true }), hubs, ON), null);
});

test('an excluded category is culled wherever it is, unless it was set by hand', () => {
  assert.equal(cullReason(ev({ category: 'music', place: 'Bathurst' }), hubs, ON), 'Excluded category: music');
  assert.equal(cullReason(ev({ category: 'Music', edited: ['category'] }), hubs, ON), null);
  assert.equal(cullReason(ev({ category: 'Motorsport' }), hubs, ON), null);
});

test('with no area on the map, nothing can be judged far from one', () => {
  assert.equal(cullReason(ev(melbourne), [{ name: 'Somewhere', lat: null, lng: null, radiusKm: 50 }], ON), null);
});
