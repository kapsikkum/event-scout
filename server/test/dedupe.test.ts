import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignDedupeGroups } from '../src/dedupe.js';
import { useZone } from './zone.js';

/**
 * One event, listed once with its time and once with only its date. On the
 * UTC day those land a day apart — 11am AEDT is 00:00 UTC on the 8th, and a
 * bare date for the 8th is local midnight, 13:00 UTC on the 7th — so the two
 * were never compared, and the event showed twice.
 */
test('a timed listing and a date-only one for the same local day are one event', (t) => {
  useZone(t, 'Australia/Sydney');
  const groups = assignDedupeGroups([
    { id: 1, title: 'Spring Fair', startTime: '2026-10-07T13:00:00.000Z', lat: null, lng: null },
    { id: 2, title: 'Spring Fair', startTime: '2026-10-08T00:00:00.000Z', lat: null, lng: null },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

const at730 = '2026-09-16T09:30:00.000Z';
const pub = { lat: -33.4199, lng: 149.5776 };

/** The pair that prompted the second pass: one gig, two titles, two spellings of the pub. */
test('one gig under two titles at the same pub and minute is one event', () => {
  const groups = assignDedupeGroups([
    { id: 1, title: 'Kavisha Mazzella live at Jack Duggans', startTime: at730, ...pub, venueName: 'Jack Duggans Irish Pub' },
    { id: 2, title: 'Kavisha Mazzella in concert with Support The Skinks', startTime: at730, ...pub, venueName: 'Jack Duggan Irish Pub' },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

test('without coordinates, a venue name in common will do', () => {
  const groups = assignDedupeGroups([
    { id: 1, title: 'Kavisha Mazzella live at Jack Duggans', startTime: at730, lat: null, lng: null, venueName: 'Jack Duggans Irish Pub' },
    { id: 2, title: 'Kavisha Mazzella in concert', startTime: at730, lat: null, lng: null, venueName: 'Jack Duggan Irish Pub' },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

test('two acts at one pub at one time stay apart', () => {
  const groups = assignDedupeGroups([
    { id: 1, title: 'Kavisha Mazzella live at Jack Duggans', startTime: at730, ...pub, venueName: 'Jack Duggans Irish Pub' },
    { id: 2, title: 'Trivia night at Jack Duggans', startTime: at730, ...pub, venueName: 'Jack Duggans Irish Pub' },
  ]);
  assert.notEqual(groups.get(1), groups.get(2), 'the venue name in both titles is not a match');
});

test('the same act at the same minute in two towns stays apart', () => {
  const groups = assignDedupeGroups([
    { id: 1, title: 'Kavisha Mazzella live', startTime: at730, ...pub, venueName: 'Jack Duggans Irish Pub' },
    { id: 2, title: 'Kavisha Mazzella in concert', startTime: at730, lat: -33.28, lng: 149.1, venueName: 'Orange Hotel' },
  ]);
  assert.notEqual(groups.get(1), groups.get(2));
});

/** Both of these were merged by the first cut of the second pass, run on the live data. */
test('two boats from one wharf at one time stay apart', () => {
  const nye = '2026-12-31T07:30:00.000Z';
  const wharf = { lat: -33.8675, lng: 151.1956 };
  const groups = assignDedupeGroups([
    { id: 1, title: 'Sydney Harbour New Year’s Eve 2026 Fireworks Cruise – MV Bubbles', startTime: nye, ...wharf, venueName: '37 Bank St' },
    { id: 2, title: "MIDNIGHT NEW YEAR'S SYDNEY FIREWORKS CRUISE (WHALE DREAMER)", startTime: nye, ...wharf, venueName: '37 Banks Street, Pyrmont NSW' },
  ]);
  assert.notEqual(groups.get(1), groups.get(2));
});

test('two sessions whose titles differ only in their time stay apart', () => {
  const at11 = '2027-02-07T00:00:00.000Z';
  const course = { lat: -33.29, lng: 149.07 };
  const groups = assignDedupeGroups([
    { id: 1, title: 'WOM Sunday Funday - 8:30AM Shotgun Start', startTime: at11, ...course, venueName: 'Duntryleague' },
    { id: 2, title: 'WOM Sunday Funday - 1:00PM Shotgun Start', startTime: at11, ...course, venueName: 'Duntryleague' },
  ]);
  assert.notEqual(groups.get(1), groups.get(2));
});

test('one event under a longer and a shorter title is one event', () => {
  const at10 = '2026-09-11T00:00:00.000Z';
  const river = { lat: -33.75, lng: 150.68 };
  const groups = assignDedupeGroups([
    { id: 1, title: 'Avli Eats X REAL Festival Penrith', startTime: at10, ...river, venueName: 'Nepean River' },
    { id: 2, title: 'Real Festival', startTime: at10, ...river, venueName: 'Tench Reserve' },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

test('days with no time are never matched on their start', () => {
  const midnight = '2026-09-15T14:00:00.000Z';
  const groups = assignDedupeGroups([
    { id: 1, title: 'Kavisha Mazzella live', startTime: midnight, ...pub, venueName: 'Jack Duggans', dateOnly: 1 },
    { id: 2, title: 'Kavisha Mazzella concert', startTime: midnight, ...pub, venueName: 'Jack Duggans', dateOnly: 1 },
  ]);
  assert.notEqual(groups.get(1), groups.get(2));
});

test('the same title on different local days stays apart', (t) => {
  useZone(t, 'Australia/Sydney');
  const groups = assignDedupeGroups([
    { id: 1, title: 'Night Markets', startTime: '2026-10-07T13:00:00.000Z', lat: null, lng: null },
    { id: 2, title: 'Night Markets', startTime: '2026-10-08T13:00:00.000Z', lat: null, lng: null },
  ]);
  assert.notEqual(groups.get(1), groups.get(2));
});
