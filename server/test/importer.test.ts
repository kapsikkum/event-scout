import { test } from 'node:test';
import assert from 'node:assert/strict';

import { candidateFromPage, candidatesFromHtml } from '../src/importer.js';
import { whenFromText } from '../src/textWhen.js';
import { useZone } from './zone.js';

const AREAS = ['Bathurst', 'Penrith NSW', 'Orange NSW'];
const sept5 = (): Date => new Date(2026, 8, 5, 12);

const ROADSTER = `Last Time Lithgow! This Time is BATHURST ‼️
We’re super excited to announce the next group event with Roadsterbros, which is our highly anticipated Bathurst drive!
Date 🗓️: 13th Sept, Sunday
Time 🕠: 5am meetup - 6am leave`;

test('the Roadster Bros caption reads as 5am on Sunday the 13th', (t) => {
  useZone(t, 'Australia/Sydney');
  assert.deepEqual(whenFromText(ROADSTER, new Date(2026, 8, 4), sept5()), {
    startTime: '2026-09-12T19:00:00.000Z',
    dateOnly: false,
  });
});

test('a page with event data offers each of its events still to come', (t) => {
  useZone(t, 'Australia/Sydney');
  const html = `<html><head><script type="application/ld+json">${JSON.stringify([
    { '@type': 'Event', name: 'Past Show', startDate: '2026-08-01T19:00:00+10:00' },
    { '@type': 'MusicEvent', name: 'Spring Gig', startDate: '2026-09-20T19:30:00+10:00',
      location: { name: 'The Victoria', address: '1 Main St, Bathurst NSW' } },
  ])}</script></head><body></body></html>`;
  const [only, ...rest] = candidatesFromHtml(html, 'https://venue.example/gig', AREAS, sept5());
  assert.equal(rest.length, 0, 'the past one is left out');
  assert.equal(only.title, 'Spring Gig');
  assert.equal(only.venueName, 'The Victoria');
  assert.equal(only.found.startTime, 'json-ld');
});

test('a page with no event data is read from its title, summary and text', (t) => {
  useZone(t, 'Australia/Sydney');
  const html = `<html><head>
    <meta property="og:title" content="Cars &amp; Coffee — Orange">
    <meta name="description" content="Monthly meet for anything with wheels.">
    <meta property="og:image" content="/img/flyer.jpg">
  </head><body><nav>Home | Events</nav>
    <p>Join us Sunday 20th September from 7:30am at the showground. Everyone welcome.</p>
    <script>var x = "1st January 2026";</script>
  </body></html>`;
  const c = candidateFromPage(html, 'https://club.example/meet', AREAS, sept5());
  assert.equal(c.title, 'Cars & Coffee — Orange');
  assert.equal(c.description, 'Monthly meet for anything with wheels.');
  assert.equal(c.imageUrl, 'https://club.example/img/flyer.jpg');
  assert.equal(c.startTime, new Date(2026, 8, 20, 7, 30).toISOString());
  assert.equal(c.found.startTime, 'text');
  assert.equal(c.address, 'Orange NSW', 'the area its title names');
});

test('a <time> element beats a date in the prose', (t) => {
  useZone(t, 'Australia/Sydney');
  const html = `<title>Swap meet</title><body><time datetime="2026-10-04">4 Oct</time> Last one was 12th September.</body>`;
  const c = candidateFromPage(html, 'https://x.example/', AREAS, sept5());
  assert.equal(c.startTime, new Date(2026, 9, 4).toISOString());
  assert.equal(c.dateOnly, true);
  assert.equal(c.found.startTime, 'page');
});

test('a page that names no date leaves it for the form to ask', () => {
  const c = candidateFromPage('<title>About us</title><body>We love cars.</body>', 'https://x.example/', AREAS, sept5());
  assert.equal(c.title, 'About us');
  assert.equal(c.startTime, '');
  assert.equal(c.found.startTime, undefined);
});
