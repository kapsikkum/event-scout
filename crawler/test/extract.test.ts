import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isWorthKeeping, parseWhen } from '../src/shared/when.js';
import { isEventType } from '../src/shared/eventTypes.js';
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

  // Floating: read as local, which is the assumption stated in shared/when.ts.
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
});

test('extracts CommunityEvent and SaleEvent with schema: prefix and mainEntity traversal', () => {
  const html = `<!doctype html><html><head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ItemPage",
    "mainEntity": {
      "@type": "schema:CommunityEvent",
      "name": "Community Tree Planting",
      "startDate": "2026-10-15 09:00:00 +1100",
      "location": {
        "@type": "Place",
        "name": "Park",
        "geo": { "@type": "GeoCoordinates", "lat": -33.85, "lon": 151.21 }
      }
    }
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "schema:SaleEvent",
    "name": "Book Fair & Sale",
    "startDate": "2026-10-16 10:00:00 -0500"
  }
  </script>
  </head></html>`;

  const events = eventsFromHtml(html, 'https://example.com/events', new Date('2026-09-11T00:00:00Z'));
  assert.equal(events.length, 2);

  const community = events.find((e) => e.title === 'Community Tree Planting');
  assert.ok(community);
  assert.equal(community.lat, -33.85);
  assert.equal(community.lng, 151.21);
  assert.equal(community.venueName, 'Park');
  assert.equal(community.startTime, '2026-10-14T22:00:00.000Z');

  const sale = events.find((e) => e.title === 'Book Fair & Sale');
  assert.ok(sale);
  assert.equal(sale.startTime, '2026-10-16T15:00:00.000Z');
});

test('a relative node.url is resolved against the page it was found on', () => {
  const html = `<!doctype html><html><head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Local Fair",
    "startDate": "2026-10-20T20:00:00Z",
    "url": "/events/local-fair"
  }
  </script>
  </head></html>`;

  const [ev] = eventsFromHtml(html, 'https://example.com/events', new Date('2026-09-11T00:00:00Z'));
  assert.ok(ev);
  assert.equal(ev.url, 'https://example.com/events/local-fair');
});

test('extracts geo coordinates using geo.lat and geo.lon fallbacks', () => {
  const html = `<!doctype html><html><head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Astronomy Night",
    "startDate": "2026-10-20T20:00:00Z",
    "location": {
      "@type": "Place",
      "name": "Observatory",
      "geo": {
        "lat": -33.8598,
        "lon": 151.2045
      }
    }
  }
  </script>
  </head></html>`;

  const [ev] = eventsFromHtml(html, 'https://example.com/events', new Date('2026-09-11T00:00:00Z'));
  assert.ok(ev);
  assert.equal(ev.lat, -33.8598);
  assert.equal(ev.lng, 151.2045);
});

test('hybrid event prefers physical place over VirtualLocation and extracts contentUrl and doorTime', () => {
  const html = `<!doctype html><html><head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": {"headline": "Tech Conference"},
    "doorTime": "2026-10-22 18:00:00 +1100",
    "image": {
      "@type": "ImageObject",
      "url": "https://example.com/page.html",
      "contentUrl": "https://example.com/banner.png"
    },
    "location": [
      {
        "@type": "VirtualLocation",
        "url": "https://zoom.us/j/123456"
      },
      {
        "@type": "Place",
        "name": "Civic Centre",
        "address": "500 George St, Sydney NSW",
        "geo": { "latitude": -33.87, "longitude": 151.20 }
      }
    ]
  }
  </script>
  </head></html>`;

  const [ev] = eventsFromHtml(html, 'https://example.com/events', new Date('2026-09-11T00:00:00Z'));
  assert.ok(ev);
  assert.equal(ev.title, 'Tech Conference');
  assert.equal(ev.venueName, 'Civic Centre');
  assert.equal(ev.address, '500 George St, Sydney NSW');
  assert.equal(ev.lat, -33.87);
  assert.equal(ev.lng, 151.20);
  assert.equal(ev.imageUrl, 'https://example.com/banner.png');
  assert.equal(ev.startTime, '2026-10-22T07:00:00.000Z');
});

test('isEventType normalizes prefixes and filters non-public types', () => {
  assert.equal(isEventType('CommunityEvent'), true);
  assert.equal(isEventType('SaleEvent'), true);
  assert.equal(isEventType('UserInteraction'), true);
  assert.equal(isEventType('Hackathon'), true);
  assert.equal(isEventType('schema:Event'), true);
  assert.equal(isEventType('schema:CommunityEvent'), true);
  assert.equal(isEventType('https://schema.org/SaleEvent'), true);
  assert.equal(isEventType('http://schema.org/MusicEvent'), true);
  assert.equal(isEventType('CustomConferenceEvent'), true);
  assert.equal(isEventType('PublicationEvent'), false);
  assert.equal(isEventType('DeliveryEvent'), false);
  assert.equal(isEventType('schema:PublicationEvent'), false);
  assert.equal(isEventType('https://schema.org/DeliveryEvent'), false);
  assert.equal(isEventType(['WebSite', 'schema:CommunityEvent']), true);
  assert.equal(isEventType(['PublicationEvent', 'DeliveryEvent']), false);
});

test('parseWhen normalizes space timestamps, colonless offsets, and doorTime', () => {
  const space = parseWhen('2026-10-15 19:30:00+11:00')!;
  assert.equal(space.startTime, '2026-10-15T08:30:00.000Z');
  assert.equal(space.dateOnly, false);

  const offsetPositive = parseWhen('2026-10-15T19:30:00+1100')!;
  assert.equal(offsetPositive.startTime, '2026-10-15T08:30:00.000Z');

  const offsetNegative = parseWhen('2026-10-15 19:30:00-0500')!;
  assert.equal(offsetNegative.startTime, '2026-10-16T00:30:00.000Z');

  const doorObj = parseWhen({ doorTime: '2026-10-15 19:30:00+1100' })!;
  assert.equal(doorObj.startTime, '2026-10-15T08:30:00.000Z');

  const doorFallback = parseWhen(undefined, '2026-10-15 19:30:00+1100')!;
  assert.equal(doorFallback.startTime, '2026-10-15T08:30:00.000Z');
});

test('collectEvents traverses mainEntity, about, and hasPart', () => {
  const html = `<!doctype html><html><head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "about": {
      "@type": "Event",
      "name": "About Event",
      "startDate": "2026-10-10T10:00:00Z"
    },
    "hasPart": [
      {
        "@type": "Event",
        "name": "HasPart Event",
        "startDate": "2026-10-11T10:00:00Z"
      }
    ]
  }
  </script>
  </head></html>`;

  const events = eventsFromHtml(html, 'https://example.com/page', new Date('2026-09-11T00:00:00Z'));
  assert.equal(events.length, 2);
  assert.ok(events.some((e) => e.title === 'About Event'));
  assert.ok(events.some((e) => e.title === 'HasPart Event'));
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
