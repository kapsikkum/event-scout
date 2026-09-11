import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isForChildren } from '../src/children.js';
import { photoScore } from '../src/photoScore.js';

test('an event aimed at children is one', () => {
  // The listing that started this: nothing in the title, "your child" below it.
  assert.equal(isForChildren(
    'Highland Dancing classes during school terms',
    'Ready to see your child grow with confidence, strength, and joy in every step?'
  ), true);
  assert.equal(isForChildren('Junior parkrun'), true);
  assert.equal(isForChildren('Kids Art Workshop'), true);
  assert.equal(isForChildren('Clay play', 'A hands-on session for ages 5-12.'), true);
  assert.equal(isForChildren('Swim squad', 'Under 12s training, Tuesdays.'), true);
  assert.equal(isForChildren('Studio open day', 'A studio where children can learn Highland Dancing.'), true);
  assert.equal(isForChildren('Museum trail', 'A school holiday program with a treasure hunt.'), true);
});

test('children mentioned in passing do not make it a children\'s event', () => {
  assert.equal(isForChildren('Bathurst Car Show', 'Entry $20, kids under 12 free. Food trucks all day.'), false);
  assert.equal(isForChildren('Orange Wine Festival', 'Live bands, a kids zone and face painting. Children welcome.'), false);
  assert.equal(isForChildren('Harvest Market', 'Family-friendly, bring the kids. Adults $5, ages 5-15 $2.'), false);
  assert.equal(isForChildren('Canteen fundraiser BBQ'), false, 'a word boundary, not a substring');
  assert.equal(isForChildren('Picton Cars and Coffee', 'Under 12s free.'), false);
});

/** Each of these was flagged on the production data by the first version. */
test('what a big event lays on for the kids who come does not make it theirs', () => {
  assert.equal(isForChildren('Greek Festival', 'Family-friendly, with games and activities for children.'), false);
  assert.equal(isForChildren('Christmas Carols', 'A range of activities for children and families: face painting, jumping castles.'), false);
  assert.equal(isForChildren('Moon Festival', 'Lion dancing, and lantern-making workshops for children.'), false);
  assert.equal(isForChildren('Village Fair', 'Rides on the main road, providing fun for children.'), false);
  assert.equal(isForChildren('Handmade and Homegrown', 'Artisan stalls and live music while your little ones are entertained.'), false);
  assert.equal(isForChildren('Community Day', 'The Watotos Corner, designed specifically for children.'), false);
  // The title still speaks for itself.
  assert.equal(isForChildren('Kids Festival'), true);
});

test('the keyword score for a children\'s event is zero', () => {
  const ev = {
    sourceId: 'x', title: 'Kids Carnival Parade', startTime: '2026-10-08T00:00:00.000Z',
    description: 'Floats, fireworks and a festival.', imageUrl: 'https://example.test/a.jpg',
  };
  assert.equal(photoScore(ev), 0);
  assert.ok(photoScore({ ...ev, title: 'Carnival Parade' }) > 0);
});
