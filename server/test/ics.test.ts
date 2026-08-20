import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildIcs, foldLine } from '../src/ics.js';

const EVENT = {
  uid: 'abc123',
  title: 'Ford Falcon Tribute Cruise',
  description: 'A cruise; with punctuation, and\na newline.',
  startTime: '2026-08-22T00:00:00.000Z',
  endTime: null,
  venueName: 'Mount Panorama',
  address: 'Mountain Straight, Bathurst, NSW, 2795',
  url: 'https://example.com/e/1',
};

/**
 * Outlook refuses a calendar that breaks the spec and reports only that it
 * cannot add it "right now", so the things it is strict about are worth
 * asserting rather than eyeballing.
 */

test('ends with CRLF, the last line as much as the rest', () => {
  const ics = buildIcs([EVENT]);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'), 'must end END:VCALENDAR + CRLF');
});

test('every line ends CRLF and none is a bare LF', () => {
  const ics = buildIcs([EVENT]);
  assert.equal(/(?<!\r)\n/.test(ics), false, 'no LF without a CR before it');
});

test('no line exceeds 75 octets', () => {
  const long = { ...EVENT, description: 'x'.repeat(600), title: 'é'.repeat(90) };
  for (const line of buildIcs([long]).split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `too long: ${line.slice(0, 40)}…`);
  }
});

test('folding never splits a multi-byte character', () => {
  // Em dashes are three octets each, so a naive 75-byte cut lands mid-character.
  const folded = foldLine('SUMMARY:' + '—'.repeat(40));
  assert.equal(folded.includes('\ufffd'), false, 'no replacement characters');
  assert.equal(folded.split('\r\n ').join('').length, 8 + 40);
});

test('separators and newlines are escaped, not emitted raw', () => {
  const ics = buildIcs([EVENT]);
  const description = ics.split('\r\n').find((l) => l.startsWith('DESCRIPTION:'));
  assert.ok(description);
  // String.raw, so these are the two-character sequences the file must
  // contain rather than the characters they escape.
  assert.ok(description.includes(String.raw`\;`), 'semicolon escaped');
  assert.ok(description.includes(String.raw`\,`), 'comma escaped');
  assert.ok(description.includes(String.raw`\n`), 'newline escaped');
  assert.equal(/(?<!\r)\n/.test(description), false, 'no raw newline inside a value');
});

test('carries a calendar name, which is what a subscriber sees', () => {
  const ics = buildIcs([EVENT], { name: 'Event Scout · Bathurst' });
  assert.ok(ics.includes('X-WR-CALNAME:Event Scout · Bathurst\r\n'));
});

test('an event with no end still gets a DTEND', () => {
  const ics = buildIcs([EVENT]);
  assert.ok(/DTEND:\d{8}T\d{6}Z/.test(ics), 'clients reject a VEVENT with neither DTEND nor DURATION');
});
