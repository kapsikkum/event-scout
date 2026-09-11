import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  eventFromPost, instagramPost, instagramProfilePosts, socialKind, whenFromCaption,
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

test('a profile page lists its recent posts', () => {
  const html = '<script>{"code":"DdGV-zAk2hq","x":1},{"code":"DdGV-zAk2hq"}</script><a href="/p/DcqBXHJk8K4/">';
  assert.deepEqual(instagramProfilePosts(html), ['DdGV-zAk2hq', 'DcqBXHJk8K4']);
});
