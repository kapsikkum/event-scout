import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractEventsFromHtml } from '../src/sources/jsonld.js';
import { nearArea } from '../src/sources/midnightspec.js';
import { localitiesFrom } from '../src/venues.js';

/**
 * Five listings lifted verbatim from https://meets.midnightspec.com/au/nsw,
 * trimmed out of a page that carries ninety-three of them.
 *
 * Two sit in Sydney, two in Bathurst and one in Wagga Wagga, which is what the
 * locality filter has to be able to tell apart. The Khanacross is the case
 * worth keeping: its venue is at Portland, half an hour up the road, and the
 * site still files it under Bathurst — that normalisation is the only reason
 * matching on words gets anywhere.
 */
const ITEMLIST =
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": "https://meets.midnightspec.com/au/nsw#list",
    "name": "Upcoming Car Meets in New South Wales",
    "inLanguage": "en-AU",
    "dateModified": "2026-09-09",
    "itemListOrder": "https://schema.org/ItemListOrderAscending",
    "numberOfItems": 5,
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "item": {
          "@type": "Event",
          "@id": "https://meets.midnightspec.com/event/DdA5yrvilBW#event",
          "name": "Aeroflow Race 4 Real Drag Racing & Burnouts",
          "description": "Aeroflow Race 4 Real Drag Racing & Burnouts — Muscle Drag Racing & Burnouts track day in Sydney, NSW on Wednesday 9 September 2026. Hosted by Sydney Dragway. At Sydney Dragway.",
          "url": "https://meets.midnightspec.com/event/DdA5yrvilBW",
          "image": "https://images.midnightspec.com/full/DdA5yrvilBW.jpg",
          "inLanguage": "en-AU",
          "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
          "eventStatus": "https://schema.org/EventScheduled",
          "isAccessibleForFree": false,
          "startDate": "2026-09-09T19:00:00+10:00",
          "endDate": "2026-09-09T23:00:00+10:00",
          "datePublished": "2026-09-08T05:10:10",
          "dateModified": "2026-09-08T05:10:10",
          "location": {
            "@type": "Place",
            "@id": "https://meets.midnightspec.com/#place-nsw-sydney-dragway",
            "name": "Sydney Dragway",
            "address": {
              "@type": "PostalAddress",
              "addressRegion": "NSW",
              "addressCountry": "AU",
              "addressLocality": "Sydney"
            }
          },
          "organizer": {
            "@type": "Organization",
            "name": "Sydney Dragway",
            "@id": "https://www.instagram.com/sydneydragway#org",
            "url": "https://www.instagram.com/sydneydragway",
            "sameAs": [
              "https://www.instagram.com/sydneydragway"
            ]
          }
        }
      },
      {
        "@type": "ListItem",
        "position": 2,
        "item": {
          "@type": "Event",
          "@id": "https://meets.midnightspec.com/event/DdAPn3yF4rk#event",
          "name": "Roll Racing Sydney Test & Tune",
          "description": "Roll Racing Sydney Test & Tune — Muscle & JDM Roll Racing track day in Sydney, NSW on Wednesday 9 September 2026. Hosted by rollracingsydney. At Sydney Motorsport Park.",
          "url": "https://meets.midnightspec.com/event/DdAPn3yF4rk",
          "image": "https://images.midnightspec.com/full/DdAPn3yF4rk.jpg",
          "inLanguage": "en-AU",
          "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
          "eventStatus": "https://schema.org/EventScheduled",
          "isAccessibleForFree": false,
          "startDate": "2026-09-09T19:00:00+10:00",
          "endDate": "2026-09-09T23:00:00+10:00",
          "datePublished": "2026-09-07T23:01:57",
          "dateModified": "2026-09-07T23:01:57",
          "location": {
            "@type": "Place",
            "@id": "https://meets.midnightspec.com/#place-nsw-sydney-motorsport-park",
            "name": "Sydney Motorsport Park",
            "address": {
              "@type": "PostalAddress",
              "addressRegion": "NSW",
              "addressCountry": "AU",
              "addressLocality": "Sydney"
            }
          },
          "organizer": {
            "@type": "Organization",
            "name": "rollracingsydney",
            "@id": "https://www.instagram.com/rollracingsydney#org",
            "url": "https://www.instagram.com/rollracingsydney",
            "sameAs": [
              "https://www.instagram.com/rollracingsydney"
            ]
          }
        }
      },
      {
        "@type": "ListItem",
        "position": 3,
        "item": {
          "@type": "Event",
          "@id": "https://meets.midnightspec.com/event/Dcw9W_Zk1Rv#event",
          "name": "September Khanacross",
          "description": "September Khanacross — Track day in Bathurst, NSW on Sunday 13 September 2026. Hosted by Lithgow District Car Club Inc.. At Yvonne Martyn Memorial Motorsport Park, Portland.",
          "url": "https://meets.midnightspec.com/event/Dcw9W_Zk1Rv",
          "image": "https://images.midnightspec.com/full/Dcw9W_Zk1Rv.jpg",
          "inLanguage": "en-AU",
          "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
          "eventStatus": "https://schema.org/EventScheduled",
          "isAccessibleForFree": false,
          "startDate": "2026-09-13T10:00:00+10:00",
          "endDate": "2026-09-13T18:00:00+10:00",
          "location": {
            "@type": "Place",
            "@id": "https://meets.midnightspec.com/#place-nsw-yvonne-martyn-memorial-motorsport-park-portland",
            "name": "Yvonne Martyn Memorial Motorsport Park, Portland",
            "address": {
              "@type": "PostalAddress",
              "addressRegion": "NSW",
              "addressCountry": "AU",
              "addressLocality": "Bathurst"
            }
          },
          "organizer": {
            "@type": "Organization",
            "name": "Lithgow District Car Club Inc.",
            "@id": "https://www.instagram.com/nsscc_au#org",
            "url": "https://www.instagram.com/nsscc_au",
            "sameAs": [
              "https://www.instagram.com/nsscc_au"
            ]
          }
        }
      },
      {
        "@type": "ListItem",
        "position": 4,
        "item": {
          "@type": "Event",
          "@id": "https://meets.midnightspec.com/event/DUxSDfhD7_a_2#event",
          "name": "Repco Bathurst 1000",
          "description": "Repco Bathurst 1000 — Muscle Enduro Cup spectator event in Bathurst, NSW on Thursday 8 October 2026. Hosted by Supercars. At Bathurst.",
          "url": "https://meets.midnightspec.com/event/DUxSDfhD7_a_2",
          "image": "https://images.midnightspec.com/full/DUxSDfhD7_a_2.jpg",
          "inLanguage": "en-AU",
          "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
          "eventStatus": "https://schema.org/EventScheduled",
          "isAccessibleForFree": false,
          "startDate": "2026-10-08T10:00:00+11:00",
          "endDate": "2026-10-08T18:00:00+11:00",
          "location": {
            "@type": "Place",
            "@id": "https://meets.midnightspec.com/#place-nsw-bathurst",
            "name": "Bathurst",
            "address": {
              "@type": "PostalAddress",
              "addressRegion": "NSW",
              "addressCountry": "AU",
              "addressLocality": "Bathurst"
            }
          },
          "organizer": {
            "@type": "Organization",
            "name": "Supercars",
            "@id": "https://www.instagram.com/adl.gf#org",
            "url": "https://www.instagram.com/adl.gf",
            "sameAs": [
              "https://www.instagram.com/adl.gf"
            ]
          }
        }
      },
      {
        "@type": "ListItem",
        "position": 5,
        "item": {
          "@type": "Event",
          "@id": "https://meets.midnightspec.com/event/DcHrEHEyXb7#event",
          "name": "First National AGM",
          "description": "First National AGM — Car meet in Wagga Wagga, NSW on Friday 16 April 2027. Hosted by ironcrowssmc. At Wagga Wagga, NSW.",
          "url": "https://meets.midnightspec.com/event/DcHrEHEyXb7",
          "image": "https://images.midnightspec.com/full/DcHrEHEyXb7.jpg",
          "inLanguage": "en-AU",
          "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
          "eventStatus": "https://schema.org/EventScheduled",
          "isAccessibleForFree": true,
          "offers": {
            "@type": "Offer",
            "url": "https://meets.midnightspec.com/event/DcHrEHEyXb7",
            "price": "0",
            "priceCurrency": "AUD",
            "availability": "https://schema.org/InStock"
          },
          "startDate": "2027-04-16T19:00:00+10:00",
          "endDate": "2027-04-16T23:00:00+10:00",
          "location": {
            "@type": "Place",
            "@id": "https://meets.midnightspec.com/#place-nsw-wagga-wagga-nsw",
            "name": "Wagga Wagga, NSW",
            "address": {
              "@type": "PostalAddress",
              "addressRegion": "NSW",
              "addressCountry": "AU",
              "addressLocality": "Wagga Wagga"
            }
          },
          "organizer": {
            "@type": "Organization",
            "name": "ironcrowssmc",
            "@id": "https://www.instagram.com/ironcrowssmc#org",
            "url": "https://www.instagram.com/ironcrowssmc",
            "sameAs": [
              "https://www.instagram.com/ironcrowssmc"
            ]
          }
        }
      }
    ]
  };

const PAGE = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(ITEMLIST)}</` + `script></head><body></body></html>`;

const PAGE_URL = 'https://meets.midnightspec.com/au/nsw';

test('the state page yields one event per list entry, dates and venue intact', () => {
  const events = extractEventsFromHtml(PAGE, PAGE_URL);
  assert.equal(events.length, 5);

  const drags = events.find((e) => e.title === 'Aeroflow Race 4 Real Drag Racing & Burnouts');
  assert.ok(drags);
  assert.equal(drags.startTime, new Date('2026-09-09T19:00:00+10:00').toISOString());
  assert.equal(drags.endTime, new Date('2026-09-09T23:00:00+10:00').toISOString());
  assert.equal(drags.venueName, 'Sydney Dragway');
  assert.equal(drags.address, 'Sydney, NSW');
  assert.equal(drags.imageUrl, 'https://images.midnightspec.com/full/DdA5yrvilBW.jpg');
});

test('every listing keeps its own event URL as the id, not the page it was found on', () => {
  const events = extractEventsFromHtml(PAGE, PAGE_URL);
  for (const ev of events) {
    assert.match(ev.sourceId, /^https:\/\/meets\.midnightspec\.com\/event\/[A-Za-z0-9_-]+$/);
    assert.equal(ev.sourceId, ev.url);
  }
  assert.equal(new Set(events.map((e) => e.sourceId)).size, 5);
});

test('a Bathurst area keeps its own listings and drops the rest of the state', () => {
  const events = extractEventsFromHtml(PAGE, PAGE_URL);
  const localities = localitiesFrom(['Bathurst, NSW, Australia'], []);
  const kept = events.filter((ev) => nearArea(ev, localities)).map((ev) => ev.title).sort();

  // The Khanacross is at Portland; it survives because the feed files it under
  // Bathurst, which is the behaviour this filter leans on.
  assert.deepEqual(kept, ['Repco Bathurst 1000', 'September Khanacross']);
});

test('with no area to compare against, nothing is filtered out', () => {
  const events = extractEventsFromHtml(PAGE, PAGE_URL);
  assert.equal(events.filter((ev) => nearArea(ev, new Set())).length, 5);
});

test('a town whose name is a word inside another is not matched loosely', () => {
  const events = extractEventsFromHtml(PAGE, PAGE_URL);
  const wagga = localitiesFrom(['Wagga Wagga, NSW'], []);
  const kept = events.filter((ev) => nearArea(ev, wagga)).map((ev) => ev.title);
  assert.deepEqual(kept, ['First National AGM']);
});
