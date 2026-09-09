import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterEvents, paginate, parseEventQuery, QueryError } from '../src/query.js';
import type { MergedEvent } from '../src/events.js';

function event(over: Partial<MergedEvent> = {}): MergedEvent {
  return {
    group: 'g1',
    title: 'Bathurst Weekend Run',
    description: 'A drive over the mountain.',
    startTime: '2026-09-25T09:00:00.000Z',
    endTime: null,
    venueName: 'Mount Panorama',
    address: '1 Mountain Straight, Bathurst NSW',
    locality: 'Bathurst',
    place: 'Bathurst',
    lat: null,
    lng: null,
    imageUrl: '',
    category: 'Motorsport',
    priceText: '',
    isOnline: false,
    photoScore: 70,
    starred: false,
    hidden: false,
    sources: [{ source: 'MIDNIGHT_SPEC', url: 'https://example.test/1' }],
    images: [],
    members: [],
    manual: false,
    note: '',
    enriched: {},
    ...over,
  };
}

test('no parameters means what it has always meant', () => {
  const q = parseEventQuery({});
  assert.equal(q.archived, false);
  assert.equal(q.limit, undefined);
  assert.equal(q.offset, 0);
  const all = [event(), event({ group: 'g2' })];
  assert.deepEqual(paginate(filterEvents(all, q), q).page, all, 'the whole list, untouched');
});

/**
 * The documented spelling from before there were any other parameters. It has
 * to keep working, and `?archived=true` has to mean the same thing.
 */
test('the old archived=1 spelling still reads as true', () => {
  assert.equal(parseEventQuery({ archived: '1' }).archived, true);
  assert.equal(parseEventQuery({ archived: 'true' }).archived, true);
  assert.equal(parseEventQuery({ archived: '0' }).archived, false);
});

/**
 * The failure worth refusing loudly. A caller who writes ?catagory=Festivals
 * and is handed all 690 events has no reason to suspect the filter was dropped,
 * and will report the count as fact.
 */
test('a parameter it does not know is refused rather than ignored', () => {
  assert.throws(() => parseEventQuery({ catagory: 'Festivals' }), QueryError);
  assert.throws(() => parseEventQuery({ limit: 'ten' }), QueryError);
  assert.throws(() => parseEventQuery({ limit: '0' }), QueryError, 'a page of nothing is a mistake');
  assert.throws(() => parseEventQuery({ offset: '-1' }), QueryError);
  assert.throws(() => parseEventQuery({ starred: 'maybe' }), QueryError);
  assert.throws(() => parseEventQuery({ from: 'soon' }), QueryError);
  assert.throws(() => parseEventQuery({ from: '2026-09-26', to: '2026-09-25' }), QueryError);
});

/** Express turns ?category=a&category=b into an array; taking the first would lie. */
test('a repeated parameter is refused, not half-used', () => {
  assert.throws(() => parseEventQuery({ category: ['Motorsport', 'Festivals'] }), QueryError);
});

test('filters match without regard to case, and accept a list', () => {
  const events = [
    event({ group: 'a', category: 'Motorsport', locality: 'Bathurst' }),
    event({ group: 'b', category: 'Festivals', locality: 'Orange' }),
    event({ group: 'c', category: 'Live music', locality: 'Bathurst' }),
  ];
  const pick = (query: Record<string, unknown>) =>
    filterEvents(events, parseEventQuery(query)).map((e) => e.group);

  assert.deepEqual(pick({ category: 'motorsport' }), ['a']);
  assert.deepEqual(pick({ category: 'Motorsport,Live music' }), ['a', 'c']);
  assert.deepEqual(pick({ locality: 'BATHURST' }), ['a', 'c']);
  assert.deepEqual(pick({ locality: 'Bathurst', category: 'Live music' }), ['c']);
  assert.deepEqual(pick({ source: 'midnight_spec' }), ['a', 'b', 'c']);
  assert.deepEqual(pick({ source: 'HUMANITIX' }), []);
});

/**
 * A plain date has to cover the whole of that day. Read as midnight UTC, a
 * ?to=2026-09-25 would exclude an event at 9am on the 25th — a range that
 * plainly includes it.
 */
test('a date bound covers the whole day, at both ends', () => {
  const events = [
    event({ group: 'before', startTime: '2026-09-24T23:00:00.000Z' }),
    event({ group: 'during', startTime: '2026-09-25T09:00:00.000Z' }),
    event({ group: 'after', startTime: '2026-09-26T01:00:00.000Z' }),
  ];
  const pick = (query: Record<string, unknown>) =>
    filterEvents(events, parseEventQuery(query)).map((e) => e.group);

  assert.deepEqual(pick({ from: '2026-09-25', to: '2026-09-25' }), ['during']);
  assert.deepEqual(pick({ from: '2026-09-25' }), ['during', 'after']);
  assert.deepEqual(pick({ to: '2026-09-25' }), ['before', 'during']);
  // A full timestamp is still taken exactly as given.
  assert.deepEqual(pick({ from: '2026-09-25T10:00:00Z' }), ['after']);
});

test('free text reaches the venue and the address, not just the title', () => {
  const events = [
    event({ group: 'a', title: 'Bathurst Weekend Run' }),
    event({ group: 'b', title: 'Show', venueName: 'Orange Showground', address: 'Orange NSW' }),
  ];
  const pick = (q: string) => filterEvents(events, parseEventQuery({ q })).map((e) => e.group);
  assert.deepEqual(pick('bathurst'), ['a']);
  assert.deepEqual(pick('showground'), ['b']);
  assert.deepEqual(pick('mountain straight'), ['a'], 'the address is searched too');
});

test('flags filter both ways, and a score sets a floor', () => {
  const events = [
    event({ group: 'a', starred: true, photoScore: 90 }),
    event({ group: 'b', starred: false, photoScore: 40, isOnline: true }),
  ];
  const pick = (query: Record<string, unknown>) =>
    filterEvents(events, parseEventQuery(query)).map((e) => e.group);
  assert.deepEqual(pick({ starred: 'true' }), ['a']);
  assert.deepEqual(pick({ starred: 'false' }), ['b']);
  assert.deepEqual(pick({ online: '1' }), ['b']);
  assert.deepEqual(pick({ minScore: '50' }), ['a']);
});

test('a page is a window on the filtered list, and the total is what it came from', () => {
  const events = ['a', 'b', 'c', 'd', 'e'].map((group) => event({ group }));
  const page = (query: Record<string, unknown>) => {
    const q = parseEventQuery(query);
    const { page, total } = paginate(filterEvents(events, q), q);
    return { groups: page.map((e) => e.group), total };
  };
  assert.deepEqual(page({ limit: '2' }), { groups: ['a', 'b'], total: 5 });
  assert.deepEqual(page({ limit: '2', offset: '2' }), { groups: ['c', 'd'], total: 5 });
  // Past the end is an empty page, not an error: a caller walking off the end
  // should stop, not fail.
  assert.deepEqual(page({ limit: '2', offset: '99' }), { groups: [], total: 5 });
  // The total counts what matched, not what a page holds — that is the whole
  // point of sending it.
  assert.equal(page({ limit: '1', minScore: '0' }).total, 5);
});
