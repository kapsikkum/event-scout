import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  eventFromPost, instagramPost, instagramProfilePosts, placeFromText, postTime, socialKind, whenFromCaption,
} from '../src/extract/social.js';
import { queriesFor, SOCIAL_QUERIES_PER_AREA } from '../src/queries.js';

const SITE_SUFFIX = / site:(instagram\.com|facebook\.com\/events)$/;

test('Instagram and Facebook are searched by name, a couple of phrases a cycle', () => {
  const interest = { city: 'Bathurst', terms: ['car show', 'markets', 'site:instagram.com cars and coffee'] };
  const plain = queriesFor(interest, 8, 0);
  assert.ok(!plain.some((q) => SITE_SUFFIX.test(q)), 'not unless asked');
  assert.ok(plain.includes('site:instagram.com cars and coffee Bathurst'), 'a site: term goes as written');

  const social = queriesFor(interest, 8, 0, true).filter((q) => SITE_SUFFIX.test(q));
  assert.equal(social.length, SOCIAL_QUERIES_PER_AREA);
  for (const q of social) {
    assert.match(q, /Bathurst site:/);
    assert.equal((q.match(/site:/g) ?? []).length, 1, 'a written site: term is not given a second');
  }
  // The window moves: over enough hours every term is asked of both sites.
  const seen = new Set<string>();
  for (let hour = 0; hour < 4; hour++) {
    for (const q of queriesFor(interest, 8, hour * 3600_000, true)) if (SITE_SUFFIX.test(q)) seen.add(q);
  }
  assert.equal(seen.size, 4, 'two terms by two sites');
});

function inSydney(t: { after: (fn: () => void) => void }): void {
  const before = process.env.TZ;
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
  process.env.TZ = 'Australia/Sydney';
}

const on = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

test('links to Instagram and Facebook are told apart, one spelling each', () => {
  assert.deepEqual(socialKind('https://www.instagram.com/p/Dc3ABIxk-Oj/'), { kind: 'instagram-post', id: 'Dc3ABIxk-Oj', url: 'https://www.instagram.com/p/Dc3ABIxk-Oj/' });
  assert.equal(socialKind('https://www.instagram.com/mqautomotivesociety/p/Dc3ABIxk-Oj')?.url, 'https://www.instagram.com/p/Dc3ABIxk-Oj/');
  assert.deepEqual(socialKind('https://instagram.com/MQAutomotiveSociety'), { kind: 'instagram-profile', id: 'mqautomotivesociety', url: 'https://www.instagram.com/mqautomotivesociety/' });
  assert.equal(socialKind('https://www.instagram.com/explore/tags/cars/'), null);
  assert.equal(socialKind('https://www.facebook.com/events/947785614691523/?ref=newsfeed')?.url, 'https://www.facebook.com/events/947785614691523/');
  assert.equal(socialKind('https://www.facebook.com/somepage'), null);
  assert.equal(socialKind('https://example.com/p/abcdef'), null);
});

/** Shaped like the real page for this post, entities and all. */
const POST_PAGE = `<html><head>
<meta property="og:image" content="https://scontent.cdninstagram.com/v/abc.jpg?stp=x&amp;_nc_cat=106" />
<meta name="description" content="100 likes, 5 comments - mqautomotivesociety on September 4, 2026: &quot;Last Time Lithgow! This Time is BATHURST &#x203c;&#xfe0f;
We&#x2019;re super excited to announce the next group event with Roadsterbros!

ROUTE AND EVENT DETAILS ON 2ND SLIDE
Date &#x1f5d3;&#xfe0f;: 13th Sept, Sunday
Time &#x1f560;: 5am meetup - 6am leave
#mqas #bathurst&quot;." />
</head></html>`;

test('a post is read for its caption, author and date', () => {
  const post = instagramPost(POST_PAGE, 'Dc3ABIxk-Oj')!;
  assert.equal(post.author, 'mqautomotivesociety');
  assert.equal(post.postedAt?.toDateString(), on(2026, 9, 4).toDateString());
  assert.match(post.caption, /^Last Time Lithgow! This Time is BATHURST ‼️/);
  assert.match(post.caption, /Time 🕠: 5am meetup/);
  assert.equal(post.imageUrl, 'https://scontent.cdninstagram.com/v/abc.jpg?stp=x&_nc_cat=106');
});

test('a post whose caption names a date and a time becomes that event', (t) => {
  inSydney(t);
  const ev = eventFromPost(instagramPost(POST_PAGE, 'Dc3ABIxk-Oj')!, on(2026, 9, 5))!;
  assert.equal(ev.startTime, '2026-09-12T19:00:00.000Z', '5am on Sunday the 13th, AEST');
  assert.equal(ev.dateOnly, false);
  assert.equal(ev.title, 'Last Time Lithgow! This Time is BATHURST ‼️');
  assert.equal(ev.url, 'https://www.instagram.com/p/Dc3ABIxk-Oj/');
  assert.equal(ev.sourceId, 'instagram:Dc3ABIxk-Oj');
});

test('dates in the ways captions write them', (t) => {
  inSydney(t);
  const sept10 = on(2026, 9, 10);
  // A time straight after the date, and not mistaken for "September 7".
  assert.deepEqual(whenFromCaption('MQAS AGM 2026 is happening Thursday 24th September 7:30PM!', sept10),
    { startTime: '2026-09-24T09:30:00.000Z', dateOnly: false });
  // Month first, no time: the day and nothing invented.
  assert.deepEqual(whenFromCaption('Swap meet, Saturday May 2. All welcome', on(2026, 4, 1)),
    { startTime: on(2026, 5, 2).toISOString(), dateOnly: true });
  // Day first with a year, after daylight saving has started.
  assert.deepEqual(whenFromCaption('Cars & coffee Sat 12/10/2026 from 9am', sept10),
    { startTime: '2026-10-11T22:00:00.000Z', dateOnly: false });
  // A December post about January means next January.
  assert.equal(whenFromCaption('Back again Jan 10th!', on(2026, 12, 20))?.startTime, on(2027, 1, 10).toISOString());
});

test('a caption that names no upcoming date is not an event', (t) => {
  inSydney(t);
  const sept4 = on(2026, 9, 4);
  assert.equal(whenFromCaption('Great night at the track, thanks all!', sept4), null);
  // Looking back: rolls to next August, nine months out and more, so passed over.
  assert.equal(whenFromCaption('Thanks for coming out on 30th August', sept4), null);
  // "may" the verb.
  assert.equal(whenFromCaption('you may 2 wheel it in if you like', sept4), null);
  // A date that does not exist is not moved to one that does.
  assert.equal(whenFromCaption('See you 31st September', sept4), null);
});

test('a post shortcode says when it was made', () => {
  // Posted September 4, 2026, per its own page.
  const at = postTime('Dc3ABIxk-Oj')!;
  assert.ok(Math.abs(at.getTime() - Date.UTC(2026, 8, 4, 12)) < 2 * 86400_000, at.toISOString());
  // A late-2023 post, the kind a profile page still lists.
  assert.equal(postTime('C0gWULBPA-W')?.getUTCFullYear(), 2023);
  assert.equal(postTime('not a code!'), null);
});

test('a day named relative to the post, when the caption gives no date', (t) => {
  inSydney(t);
  const wed = on(2026, 9, 9);
  assert.deepEqual(whenFromCaption('Cars and coffee this Sunday from 7am, all welcome', wed),
    { startTime: new Date(2026, 8, 13, 7, 0).toISOString(), dateOnly: false });
  assert.deepEqual(whenFromCaption('Live music tonight 8pm!', wed),
    { startTime: new Date(2026, 8, 9, 20, 0).toISOString(), dateOnly: false });
  assert.deepEqual(whenFromCaption('Markets back tomorrow', wed),
    { startTime: on(2026, 9, 10).toISOString(), dateOnly: true });
  assert.equal(whenFromCaption('See you this weekend', wed)?.startTime, on(2026, 9, 12).toISOString());
  // A stated date still wins over a relative word.
  assert.equal(whenFromCaption('This Sunday? No — 20th September', wed)?.startTime, on(2026, 9, 20).toISOString());
  // "Book today" is not a date.
  assert.equal(whenFromCaption('Book today, spots are limited', wed), null);
});

test('a profile page lists its recent posts', () => {
  const html = '<script>{"code":"DdGV-zAk2hq","x":1},{"code":"DdGV-zAk2hq"}</script><a href="/p/DcqBXHJk8K4/">';
  assert.deepEqual(instagramProfilePosts(html), ['DdGV-zAk2hq', 'DcqBXHJk8K4']);
});

const AREAS = ['Bathurst', 'Penrith NSW', 'Orange NSW', 'Eastern Creek NSW'];

test('a caption that names one of the areas is placed in it', () => {
  assert.equal(placeFromText('our highly anticipated Bathurst drive! drive to Bathurst/ Mount Panorama', AREAS), 'Bathurst');
  assert.equal(placeFromText('Meet at Penrith, then on to Eastern Creek', AREAS), 'Penrith NSW', 'the first one named');
  assert.equal(placeFromText('Cars and coffee at Eastern Creek raceway', AREAS), 'Eastern Creek NSW');
});

test('a word that only looks like an area is not one', () => {
  assert.equal(placeFromText('bring your orange car and a friend', AREAS), undefined, 'lower case is the fruit');
  assert.equal(placeFromText('Bathursts finest', AREAS), undefined, 'part of a longer word');
  assert.equal(placeFromText('no town here at all', AREAS), undefined);
});

test('the Roadster Bros post comes out placed in Bathurst', (t) => {
  inSydney(t);
  const post = instagramPost(POST_PAGE, 'Dc3ABIxk-Oj')!;
  const ev = eventFromPost(post, on(2026, 9, 5), AREAS)!;
  assert.equal(ev.address, 'Bathurst');
  assert.equal(eventFromPost(post, on(2026, 9, 5))!.address, undefined, 'and without areas, nowhere');
});
