import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isWorthKeeping, parseWhen } from '../src/extract/when.js';
import { eventsFromHtml, jsonLdBlocks } from '../src/extract/jsonld.js';
import { crawlableLinks, feedsFrom, linksFrom } from '../src/extract/links.js';
import { eventLikeness, normalizeUrl, sameSite, siteOf } from '../src/urls.js';

/**
 * The bug this crawler exists not to repeat. In event-scout's live data 135 of
 * 386 events showed an invented 11:00 am start, because the page published a
 * bare date and `new Date('2026-10-08')` means UTC midnight.
 */
test('a bare date is the right day, and admits it has no time', (t) => {
  const before = process.env.TZ;
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
  process.env.TZ = 'Australia/Sydney';

  const bare = parseWhen('2026-10-08')!;
  assert.equal(bare.dateOnly, true, 'the page gave no clock time');
  // Local midnight, not UTC midnight: the naive reading lands at 11am local.
  const shown = new Date(bare.startTime).toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
  assert.match(shown, /8 Oct/, 'still the 8th');
  assert.match(shown, /12:00\s*am/i, 'and midnight here, not mid-morning');
});

test('a stated time is kept, and is not flagged as missing', (t) => {
  const before = process.env.TZ;
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
  process.env.TZ = 'Australia/Sydney';

  // Floating: read as local, which is the assumption stated in when.ts.
  const floating = parseWhen('2026-10-08T10:00:00')!;
  assert.equal(floating.dateOnly, false);
  assert.equal(floating.startTime, '2026-10-07T23:00:00.000Z', '10am AEDT');

  // With an offset: already absolute, and must not be shifted again.
  assert.equal(parseWhen('2026-10-08T10:00:00+11:00')!.startTime, '2026-10-07T23:00:00.000Z');
  assert.equal(parseWhen('2026-10-08T10:00:00Z')!.startTime, '2026-10-08T10:00:00.000Z');
});

test('junk in place of a date is no date', () => {
  // A rolled-over date is the dangerous one: new Date(2026, 12, 45) is not
  // an error, it is February 2027, so a garbage string would quietly become a
  // real event on a real day.
  for (const junk of ['', '   ', 'soon', 'TBA', '2026-13-45', '2026-02-30', '2026-00-10']) {
    assert.equal(parseWhen(junk), null, junk);
  }
});

test('events long past or absurdly far off are not worth a page', () => {
  const now = new Date('2026-09-11T00:00:00Z');
  assert.equal(isWorthKeeping('2026-09-20T00:00:00Z', now), true);
  assert.equal(isWorthKeeping('2025-01-01T00:00:00Z', now), false);
  assert.equal(isWorthKeeping('2030-01-01T00:00:00Z', now), false);
});

// --- JSON-LD ----------------------------------------------------------------

const PAGE = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"Not an event"},
  {"@type":"Festival","name":"Spring Fair","startDate":"2026-10-08T10:00:00+11:00",
   "endDate":"2026-10-08T16:00:00+11:00",
   "description":"<p>Rides &amp; stalls</p>",
   "image":"https://example.com/f.jpg",
   "url":"https://example.com/events/spring-fair",
   "location":{"@type":"Place","name":"Showground",
     "address":{"@type":"PostalAddress","streetAddress":"1 Main St","addressLocality":"Bathurst","addressRegion":"NSW","postalCode":"2795"},
     "geo":{"@type":"GeoCoordinates","latitude":-33.41,"longitude":149.58}},
   "offers":{"@type":"Offer","price":"0","priceCurrency":"AUD"}}
]}
</script></head><body>
<a href="/events/spring-fair">Spring Fair</a>
<a href="/events/2026/10/09/night-markets">Night markets</a>
<a href="/admin/login">Login</a>
<a href="https://elsewhere.example.org/events/other">Off site</a>
<link rel="alternate" type="text/calendar" href="/events/feed.ics">
</body></html>`;

test('an event is read out of a page, with its place and price', () => {
  const [ev, ...rest] = eventsFromHtml(PAGE, 'https://example.com/events', new Date('2026-09-11T00:00:00Z'));
  assert.equal(rest.length, 0, 'the WebSite node is not an event');
  assert.equal(ev.title, 'Spring Fair');
  assert.equal(ev.startTime, '2026-10-07T23:00:00.000Z');
  assert.equal(ev.dateOnly, false);
  assert.equal(ev.venueName, 'Showground');
  assert.equal(ev.address, '1 Main St, Bathurst, NSW, 2795');
  assert.equal(ev.lat, -33.41);
  assert.equal(ev.priceText, 'Free', 'a price of 0 is worth saying plainly');
  assert.equal(ev.description, 'Rides & stalls', 'tags and entities out');
  assert.equal(ev.foundOn, 'https://example.com/events');
});

/** Calendars routinely emit one event twice, inline and again in @graph. */
test('the same event twice on a page is one event', () => {
  const doubled = PAGE.replace('</head>', `<script type="application/ld+json">
    {"@type":"Festival","name":"Spring Fair","startDate":"2026-10-08T10:00:00+11:00"}
  </script></head>`);
  assert.equal(eventsFromHtml(doubled, 'https://example.com/events', new Date('2026-09-11T00:00:00Z')).length, 1);
});

test('a page with nothing structured yields nothing rather than throwing', () => {
  assert.deepEqual(eventsFromHtml('<html><body>hi</body></html>', 'https://x.com'), []);
  assert.deepEqual(eventsFromHtml('', 'https://x.com'), []);
});

/** Trailing commas are common enough in the wild to be worth one repair. */
test('slightly malformed JSON-LD is still read', () => {
  const blocks = jsonLdBlocks('<script type="application/ld+json">{"a":1,}</script>');
  assert.deepEqual(blocks, [{ a: 1 }]);
  assert.deepEqual(jsonLdBlocks('<script type="application/ld+json">not json at all</script>'), []);
});

// --- links and urls ---------------------------------------------------------

test('links are followed on the same site only, best first', () => {
  const links = crawlableLinks(PAGE, 'https://example.com/events');
  const urls = links.map((l) => l.url);
  assert.ok(!urls.some((u) => u.includes('elsewhere.example.org')), 'off site is out of scope');
  assert.ok(urls.some((u) => u.endsWith('/events/2026/10/09/night-markets')));
  // A dated event path outranks a login form, which is the whole point of
  // scoring: the budget runs out long before the site does.
  const dated = links.findIndex((l) => l.url.includes('night-markets'));
  const login = links.findIndex((l) => l.url.includes('admin/login'));
  assert.ok(dated < login || login === -1, 'the event link is preferred');
});

test('a calendar feed is spotted however it is advertised', () => {
  assert.deepEqual(feedsFrom(PAGE, 'https://example.com/events'), ['https://example.com/events/feed.ics']);
  assert.deepEqual(
    feedsFrom('<a href="/cal/?ical=1">Subscribe</a>', 'https://example.com/'),
    ['https://example.com/cal?ical=1']
  );
});

test('mailto, javascript and fragments are not links to fetch', () => {
  const html = '<a href="mailto:a@b.c">m</a><a href="javascript:void(0)">j</a><a href="#top">t</a><a href="/real">r</a>';
  assert.deepEqual(linksFrom(html, 'https://example.com/'), ['https://example.com/real']);
});

test('one page has one spelling', () => {
  const canonical = 'https://example.com/events?a=1&b=2';
  for (const variant of [
    'https://EXAMPLE.com/events?b=2&a=1',
    'https://example.com/events/?a=1&b=2#top',
    'https://example.com:443/events?a=1&b=2&utm_source=news',
    'https://example.com/events?b=2&a=1&fbclid=xyz',
  ]) {
    assert.equal(normalizeUrl(variant), canonical, variant);
  }
  // A meaningful parameter is not junk: most calendar plugins publish this way.
  assert.equal(normalizeUrl('https://example.com/e?event=123'), 'https://example.com/e?event=123');
  assert.equal(normalizeUrl('ftp://example.com/x'), null, 'not a page');
  assert.equal(normalizeUrl('not a url'), null);
});

test('subdomains of one site count as that site', () => {
  assert.equal(siteOf('https://www.example.com/a'), 'example.com');
  assert.equal(siteOf('https://events.example.com.au/a'), 'example.com.au');
  assert.ok(sameSite('https://www.example.com/a', 'https://events.example.com/b'));
  assert.ok(!sameSite('https://example.com/a', 'https://example.org/b'));
});

test('a url that looks like events outranks one that looks like plumbing', () => {
  assert.ok(eventLikeness('https://x.com/events/spring-fair') > eventLikeness('https://x.com/about'));
  assert.ok(eventLikeness('https://x.com/whats-on') > eventLikeness('https://x.com/tag/news'));
  assert.ok(eventLikeness('https://x.com/events/2026/10/08/fair') > eventLikeness('https://x.com/events'));
  assert.ok(eventLikeness('https://x.com/login') < 0);
});
