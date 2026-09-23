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

test('a post naming an event joins the one listing that day that says where it is', (t) => {
  useZone(t, 'Australia/Sydney');
  const listing = { id: 1, title: 'SMSP Open Pit Lane: Bathurst Shakedown', startTime: '2026-09-23T09:00:00.000Z', lat: null, lng: null, venueName: 'Sydney Motorsport Park' };
  const post = { id: 2, title: 'SMSP OPEN PIT LANE', startTime: '2026-09-22T14:00:00.000Z', lat: null, lng: null, venueName: '', dateOnly: 1 };
  const groups = assignDedupeGroups([listing, post]);
  assert.equal(groups.get(1), groups.get(2));

  // Two meets that Sunday both match "cars and coffee": the post joins neither.
  const sunday = '2026-09-27T00:00:00.000Z';
  const vague = assignDedupeGroups([
    { id: 3, title: 'Cars and Coffee Penrith', startTime: sunday, lat: null, lng: null, venueName: 'Panthers' },
    { id: 4, title: 'Cars and Coffee Orange', startTime: sunday, lat: null, lng: null, venueName: 'Robertson Park' },
    { id: 5, title: 'Cars and Coffee', startTime: '2026-09-26T14:00:00.000Z', lat: null, lng: null, venueName: '' },
  ]);
  assert.notEqual(vague.get(5), vague.get(3));
  assert.notEqual(vague.get(5), vague.get(4));
});

test('order of input events does not affect assigned dedupe group IDs', (t) => {
  useZone(t, 'Australia/Sydney');
  const events = [
    { id: 10, title: 'Spring Fair', startTime: '2026-10-07T13:00:00.000Z', lat: null, lng: null },
    { id: 2, title: 'Spring Fair', startTime: '2026-10-08T00:00:00.000Z', lat: null, lng: null },
    { id: 5, title: 'Farmers Market', startTime: '2026-10-08T01:00:00.000Z', lat: -33.8688, lng: 151.2093, venueName: 'Sydney Market' },
    { id: 1, title: 'Farmers Market', startTime: '2026-10-08T01:00:00.000Z', lat: -33.4199, lng: 149.5776, venueName: 'Bathurst Market' },
    { id: 8, title: 'Kavisha Mazzella live at Jack Duggans', startTime: at730, ...pub, venueName: 'Jack Duggans Irish Pub' },
    { id: 3, title: 'Kavisha Mazzella in concert with Support The Skinks', startTime: at730, ...pub, venueName: 'Jack Duggan Irish Pub' },
    { id: 12, title: 'SMSP Open Pit Lane: Bathurst Shakedown', startTime: '2026-09-23T09:00:00.000Z', lat: null, lng: null, venueName: 'Sydney Motorsport Park' },
    { id: 4, title: 'SMSP OPEN PIT LANE', startTime: '2026-09-22T14:00:00.000Z', lat: null, lng: null, venueName: '', dateOnly: 1 },
    { id: 7, title: 'Solo Acoustic Night', startTime: '2026-10-15T09:00:00.000Z', lat: -33.8, lng: 151.0, venueName: 'Acoustic Bar' },
  ];

  const canonical = assignDedupeGroups(events);
  const reversed = assignDedupeGroups([...events].reverse());

  const shuffle = (arr: typeof events, seed: number) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = (seed * (i + 1) + 7) % (i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  assert.equal(canonical.size, events.length);
  for (const ev of events) {
    assert.equal(reversed.get(ev.id), canonical.get(ev.id), `reversed order mismatch for event ${ev.id}`);
  }

  for (let seed = 1; seed <= 5; seed++) {
    const shuffled = assignDedupeGroups(shuffle(events, seed));
    for (const ev of events) {
      assert.equal(shuffled.get(ev.id), canonical.get(ev.id), `shuffled (seed ${seed}) mismatch for event ${ev.id}`);
    }
  }
});

test('the same event on the same day with slightly differing geocoder positions merges', (t) => {
  useZone(t, 'Australia/Sydney');
  // Two scrapers geocoded the same town center ~470m apart
  const groups = assignDedupeGroups([
    { id: 1, title: '2026 Rally of Oberon', startTime: '2026-11-13T23:00:00.000Z', lat: -33.70415, lng: 149.8588, venueName: 'Oberon' },
    { id: 2, title: '2026 Rally of Oberon', startTime: '2026-11-13T13:00:00.000Z', lat: -33.705002, lng: 149.863754, venueName: 'Oberon' },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

test('year suffix is ignored when deduplicating: Challenge Bathurst and Challenge Bathurst 2026 at same venue same day merge', (t) => {
  useZone(t, 'Australia/Sydney');
  const circuit = { lat: -33.44199, lng: 149.557571 };
  const groups = assignDedupeGroups([
    { id: 1, title: 'Challenge Bathurst', startTime: '2026-11-18T13:00:00.000Z', ...circuit, venueName: 'Mount Panorama Circuit', dateOnly: 1 },
    { id: 2, title: 'Challenge Bathurst 2026', startTime: '2026-11-18T13:00:00.000Z', ...circuit, venueName: 'Mount Panorama Circuit', dateOnly: 1 },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

test('multi-day spans that overlap at the same venue merge', (t) => {
  useZone(t, 'Australia/Sydney');
  const circuit = { lat: -33.44199, lng: 149.557571 };
  // Nov 18-22 and Nov 20-22 overlap at Mount Panorama
  const groups = assignDedupeGroups([
    { id: 1, title: 'Challenge Bathurst', startTime: '2026-11-18T13:00:00.000Z', endTime: '2026-11-22T13:00:00.000Z', ...circuit, venueName: 'Mount Panorama Circuit', dateOnly: 1 },
    { id: 2, title: 'Challenge Bathurst', startTime: '2026-11-20T13:00:00.000Z', endTime: '2026-11-22T13:00:00.000Z', ...circuit, venueName: 'Mount Panorama Circuit', dateOnly: 1 },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

test('pipelined sub-event title merges with parent via title venue extraction', (t) => {
  useZone(t, 'Australia/Sydney');
  const circuit = { lat: -33.44199, lng: 149.557571 };
  const groups = assignDedupeGroups([
    { id: 1, title: 'Challenge Bathurst', startTime: '2026-11-18T13:00:00.000Z', ...circuit, venueName: 'Mount Panorama Circuit', dateOnly: 1 },
    { id: 2, title: 'Challenge Bathurst | Regularity Event | Mount Panorama', startTime: '2026-11-18T13:00:00.000Z', lat: -33.4166482, lng: 149.5803725, venueName: '', dateOnly: 1 },
  ]);
  assert.equal(groups.get(1), groups.get(2));
});

test('overlapping date spans with different sub-titles at different venues stay apart', () => {
  const circuit = { lat: -33.44199, lng: 149.557571 };
  const oval = { lat: -33.42, lng: 149.56 };
  const groups = assignDedupeGroups([
    { id: 1, title: 'Bathurst Racing Festival', startTime: '2026-11-18T13:00:00.000Z', endTime: '2026-11-22T13:00:00.000Z', ...circuit, venueName: 'Mount Panorama Circuit', dateOnly: 1 },
    { id: 2, title: 'Bathurst Racing Festival', startTime: '2026-11-20T13:00:00.000Z', endTime: '2026-11-22T13:00:00.000Z', lat: -34.0, lng: 150.0, venueName: 'Some Other Circuit', dateOnly: 1 },
  ]);
  assert.notEqual(groups.get(1), groups.get(2));
});
