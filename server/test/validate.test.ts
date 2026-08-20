import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanAddress, cleanDescription, consensusStart, validateAddress, validateDates, validateLocation } from '../src/validate.js';
import type { Location, RawEvent } from '../src/sources/types.js';

/**
 * Both halves of this file are regressions from real rows in the database.
 *
 * A Bathurst market page carried startDate 2025-08-22 into 2026, so the app
 * showed a Saturday market on a Friday a year gone; and a car cruise listed by
 * five sources had four saying the 22nd and one saying the 21st, with the
 * outlier winning because the merge read the earliest member.
 */

const NOW = Date.parse('2026-08-20T00:00:00Z');

test('rejects a start that has already been and gone', () => {
  const v = validateDates({ startTime: '2025-08-22T12:00:00.000Z' }, NOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /past/);
});

test('accepts an event already under way today', () => {
  assert.equal(validateDates({ startTime: '2026-08-19T20:00:00Z' }, NOW).ok, true);
});

test('rejects a start beyond the horizon', () => {
  const v = validateDates({ startTime: '2028-01-01T00:00:00Z' }, NOW);
  assert.equal(v.ok, false);
  assert.match(v.reason, /horizon/);
});

test('keeps the event but drops an end that outruns the start by months', () => {
  const v = validateDates({ startTime: '2026-08-22T00:00:00Z', endTime: '2026-10-23T15:00:00Z' }, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.endTime, null);
});

test('keeps a plausible end', () => {
  const v = validateDates({ startTime: '2026-08-22T00:00:00Z', endTime: '2026-08-22T05:00:00Z' }, NOW);
  assert.equal(v.endTime, '2026-08-22T05:00:00.000Z');
});

test('drops an end that precedes its start', () => {
  const v = validateDates({ startTime: '2026-08-22T09:00:00Z', endTime: '2026-08-22T08:00:00Z' }, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.endTime, null);
});

test('rejects unparsable and missing starts', () => {
  assert.equal(validateDates({ startTime: 'next Saturday' }, NOW).ok, false);
  assert.equal(validateDates({}, NOW).ok, false);
});

const AREA: Location = { lat: -33.4193, lng: 149.5775, radiusKm: 50, city: 'Bathurst, NSW' };
const at = (lat: number, lng: number): RawEvent =>
  ({ sourceId: 'x', title: 'x', startTime: '2026-08-22T00:00:00Z', lat, lng }) as RawEvent;

test('a venue in the area passes, one on the far side of the country does not', () => {
  assert.equal(validateLocation(at(-33.42, 149.58), [AREA]).ok, true);
  assert.equal(validateLocation(at(-31.95, 115.86), [AREA]).ok, false);
});

test('an event with no coordinates is left for the geocoder to place', () => {
  assert.equal(validateLocation({ sourceId: 'x', title: 'x', startTime: '2026-08-22T00:00:00Z' } as RawEvent, [AREA]).ok, true);
});

test('the date most members agree on wins, not the earliest', () => {
  const starts = [
    '2026-08-21T00:00:00.000Z',
    '2026-08-22T00:00:00.000Z',
    '2026-08-22T00:00:00.000Z',
    '2026-08-22T00:00:00.000Z',
    '2026-08-22T00:00:00.000Z',
  ];
  assert.equal(consensusStart(starts), '2026-08-22T00:00:00.000Z');
});

test('a tie breaks towards the earlier date, and the earliest start within the winning day is used', () => {
  assert.equal(consensusStart(['2026-08-22T09:00:00Z', '2026-08-21T09:00:00Z']), '2026-08-21T09:00:00Z');
  assert.equal(
    consensusStart(['2026-08-22T14:00:00Z', '2026-08-22T09:00:00Z', '2026-08-21T08:00:00Z']),
    '2026-08-22T09:00:00Z'
  );
});

test('a lone member is its own consensus', () => {
  assert.equal(consensusStart(['2026-08-21T09:00:00Z']), '2026-08-21T09:00:00Z');
  assert.equal(consensusStart([]), '');
});

/**
 * The address half. Every input here is a real stored value: JSON-LD hands
 * over a streetAddress that is already complete plus separate locality and
 * region fields, and the parser appended all of them, so 174 of 324 stored
 * addresses ended with the town repeated and the state cut to "NS".
 */

test('drops a locality and state already spelled out in the street address', () => {
  assert.equal(
    cleanAddress('114 Rankin St, Bathurst NSW 2795, Australia, Bathurst, NS', 'NSW'),
    '114 Rankin St, Bathurst NSW 2795, Australia'
  );
});

test('keeps a suburb the venue name merely happens to contain', () => {
  assert.equal(
    cleanAddress('Bathurst Memorial Entertainment Centre, Bathurst, NS, Australia, Bathurst, NS', 'NSW'),
    'Bathurst Memorial Entertainment Centre, Bathurst, NSW, Australia'
  );
});

test('collapses a repeated tail and a duplicated postcode', () => {
  assert.equal(
    cleanAddress('Kendall Avenue (Great Western Highway), Bathurst Showground, Bathurst NSW 2795, Bathurst, NSW, 2795'),
    'Kendall Avenue (Great Western Highway), Bathurst Showground, Bathurst NSW 2795'
  );
});

test('drops empty components and expands a truncated state', () => {
  assert.equal(cleanAddress('127 Station Street, , NSW, 2750'), '127 Station Street, NSW, 2750');
  assert.equal(cleanAddress('Mountain Straight,Bathurst,NSW,Australia, Bathurst, NS', 'NSW'), 'Mountain Straight, Bathurst, NSW, Australia');
});

test('leaves an address that is already clean alone', () => {
  assert.equal(cleanAddress('76 Bentinck Street, Bathurst, NSW, 2795'), '76 Bentinck Street, Bathurst, NSW, 2795');
});

test('placeholders become an empty address rather than a fake one', () => {
  assert.equal(validateAddress('TBA'), '');
  assert.equal(validateAddress('To be announced'), '');
  assert.equal(validateAddress(undefined), '');
  assert.equal(validateAddress('Various locations, Bathurst, NSW'), 'Bathurst, NSW');
});

test('cuts the search area a source stapled on after the country', () => {
  assert.equal(cleanAddress('Neville, NSW, Australia, Bathurst'), 'Neville, NSW, Australia');
  assert.equal(cleanAddress('Bathurst, NSW, Australia'), 'Bathurst, NSW, Australia');
});

/**
 * Descriptions arrive as whatever the source's CMS had lying around. All
 * three inputs below are real: a WordPress block comment wrapped in tags, a
 * "read more" anchor spliced mid-sentence, and the two literal characters
 * backslash-n where a paragraph break belongs.
 */

test('strips WordPress block comments and paragraph tags', () => {
  assert.equal(
    cleanDescription('<p><!-- wp:paragraph --></p>\n<p>Get ready for the Penrith Show!</p>\n<p><!-- /wp:paragraph --></p>'),
    'Get ready for the Penrith Show!'
  );
});

test('strips an anchor spliced into the middle of a sentence', () => {
  assert.equal(
    cleanDescription('Kick off your celebrations with Back<a class="excerpt-read-more" href="#">Read more</a>'),
    'Kick off your celebrations with BackRead more'
  );
});

test('turns the two literal characters backslash-n into a real break', () => {
  assert.equal(cleanDescription('First line.\nSecond line.'), 'First line.\nSecond line.');
  assert.equal(cleanDescription('First line.\r\nSecond line.'), 'First line.\nSecond line.');
});

test('decodes entities, including markup that arrived double-escaped', () => {
  assert.equal(cleanDescription('Rock &amp; roll &#8211; it&#8217;s on'), 'Rock & roll – it’s on');
  assert.equal(cleanDescription('&lt;p&gt;Hidden markup&lt;/p&gt;'), 'Hidden markup');
});

test('collapses runaway whitespace and leaves clean text alone', () => {
  assert.equal(cleanDescription('Line one.\n\n\n\n\nLine two.'), 'Line one.\n\nLine two.');
  assert.equal(cleanDescription('A plain blurb about a car show.'), 'A plain blurb about a car show.');
  assert.equal(cleanDescription(undefined), '');
});
