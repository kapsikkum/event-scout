import { test } from 'node:test';
import assert from 'node:assert/strict';

import { feedUrl, parseFeed } from '../src/sources/ical.js';

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:Orange City Council',
  'BEGIN:VEVENT',
  'UID:fair-1',
  'DTSTART:20260920T090000Z',
  'SUMMARY;LANGUAGE=en:Spring Fair',
  'LOCATION:Robertson Park',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:show-1',
  'DTSTART;VALUE=DATE:20261003',
  'SUMMARY:Garden Show',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:past-1',
  'DTSTART:20250101T000000Z',
  'SUMMARY:Last year',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:exhibition-1',
  'DTSTART;VALUE=DATE:20260605',
  'DTEND;VALUE=DATE:20261101',
  'SUMMARY:Faces in the Crowd',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:far-1',
  'DTSTART:20290101T000000Z',
  'SUMMARY:Years away',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const NOW = new Date('2026-09-11T00:00:00Z');

test('a feed is read for its name, everything in it, and what is in range', () => {
  const feed = parseFeed(FEED, 'https://example.test/cal.ics', 'Council', NOW);
  assert.equal(feed.calendarName, 'Orange City Council');
  assert.equal(feed.total, 5);
  assert.deepEqual(feed.events.map((e) => e.title).sort(), ['Faces in the Crowd', 'Garden Show', 'Spring Fair']);
});

/** Every event in Central NSW's feed was one of these, and every one was dropped. */
test('an event that started months ago and is still running is kept', () => {
  const feed = parseFeed(FEED, 'https://example.test/cal.ics', 'Council', NOW);
  assert.ok(feed.events.some((e) => e.title === 'Faces in the Crowd'));
  assert.ok(!feed.events.some((e) => e.title === 'Last year'), 'one that has finished is still dropped');
});

test('a property with parameters is read as its text', () => {
  const fair = parseFeed(FEED, 'https://example.test/cal.ics', 'Council', NOW).events.find((e) => e.address);
  assert.equal(fair?.title, 'Spring Fair', 'not "[object Object]"');
  assert.equal(fair?.address, 'Robertson Park');
  assert.equal(fair?.dateOnly, false);
});

test('an all-day event says it has no time', () => {
  const show = parseFeed(FEED, 'https://example.test/cal.ics', 'Council', NOW).events.find((e) => e.title === 'Garden Show');
  assert.equal(show?.dateOnly, true);
});

test('a page that is not a calendar is refused rather than read as empty', () => {
  assert.throws(() => parseFeed('<!doctype html><p>Not found</p>', 'https://example.test/x', '', NOW), /not a calendar/);
});

test('webcal addresses are fetched over https', () => {
  assert.equal(feedUrl('webcal://example.test/cal.ics'), 'https://example.test/cal.ics');
  assert.equal(feedUrl(' https://example.test/cal.ics '), 'https://example.test/cal.ics');
});
