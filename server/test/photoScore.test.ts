import { test } from 'node:test';
import assert from 'node:assert/strict';

import { photoScore } from '../src/photoScore.js';
import type { RawEvent } from '../src/sources/types.js';
import { ALL_CATEGORIES } from '../src/sources/topics.js';

function ev(over: Partial<RawEvent> = {}): RawEvent {
  return {
    title: '',
    description: '',
    category: '',
    isOnline: false,
    imageUrl: '',
    ...over,
  } as RawEvent;
}

/**
 * The one that started this. The Repco Bathurst 1000 scored 15 out of 100 —
 * base plus the image bonus, because nothing else in the file matched it.
 */
test('a motorsport event is not scored like an AGM', () => {
  // A bare title with no description is the hard case, and the one that failed:
  // it has only the category to go on. It should still clear the dull half.
  const bare = photoScore(ev({ title: 'Repco Bathurst 1000', category: 'Motorsport', imageUrl: 'x' }));
  assert.ok(bare > 40, `a bare motorsport title scored ${bare}`);

  // Given anything at all to read, it should reach the top band.
  const described = photoScore(
    ev({ title: 'Repco Bathurst 1000', category: 'Motorsport', imageUrl: 'x', description: 'V8 Supercars race weekend' })
  );
  assert.ok(described >= 80, `a described motorsport event scored ${described}`);

  // And both should be far above the things this file exists to sort them from.
  for (const dull of ['Annual General Meeting', 'Weekly trivia night', 'Beginners pottery class']) {
    assert.ok(bare > photoScore(ev({ title: dull, category: 'Event' })) + 25, `barely beat ${dull}`);
  }
});

/**
 * Every category this app assigns should be worth something, or the table has
 * drifted from `topics.ts` again — which is exactly what had happened: nine of
 * the fourteen matched nothing at all.
 */
test('every category the app assigns is known to the scorer, bar the catch-all', () => {
  const unscored: string[] = [];
  for (const category of ALL_CATEGORIES) {
    if (category === 'Event') continue; // the catch-all says nothing by design
    const withCategory = photoScore(ev({ title: 'Something', category }));
    if (withCategory <= photoScore(ev({ title: 'Something', category: 'Event' }))) {
      unscored.push(category);
    }
  }
  assert.deepEqual(unscored, [], 'these categories score nothing');
});

/**
 * The substring test that quietly did nothing: the old code asked whether
 * "motorsport" contained "sports". It does not, and neither does "sport".
 */
test('a category is matched as itself, not as a substring of one', () => {
  assert.ok(photoScore(ev({ title: 'x', category: 'Motorsport' })) > 10);
  assert.ok(photoScore(ev({ title: 'x', category: 'Sport' })) > 10);
  // Case and stray whitespace are not real differences.
  assert.equal(
    photoScore(ev({ title: 'x', category: '  motorsport  ' })),
    photoScore(ev({ title: 'x', category: 'Motorsport' }))
  );
});

/**
 * Two keywords written for titles that have actually turned up here, and which
 * missed both of them: "Markets" is plural and "Car and Bike Show" is not the
 * phrase "car show".
 */
test('the plurals and looser phrasings that were being missed now match', () => {
  const plain = photoScore(ev({ title: 'Something', category: 'Event' }));
  for (const title of [
    'BX THRIFT MARKETS',
    'Swap Meet, Car and Bike Show',
    'Sunday Car Meet',
    'Truck Show',
    'Vintage Tractor Muster',
  ]) {
    assert.ok(photoScore(ev({ title, category: 'Event' })) > plain, `${title} should score above bare`);
  }
});

test('motorsport vocabulary is recognised at all', () => {
  const plain = photoScore(ev({ title: 'Something', category: 'Event' }));
  for (const title of [
    'V8 Supercars', 'Speedway Saturday', 'Drag Racing Night', 'Hillclimb Championship',
    'September Khanacross', 'Test and Tune', 'Track Day', 'Enduro Cup',
  ]) {
    assert.ok(photoScore(ev({ title, category: 'Event' })) > plain, `${title} should score above bare`);
  }
});

/**
 * The reason positives are capped. Several titles stack three or four keywords
 * and every one of them landed on 100, which tells the sort nothing.
 */
test('stacked keywords do not all pile up on 100', () => {
  const stacked = [
    ev({ title: 'Swap Meet, Car and Bike Show', category: 'Cars & bikes', imageUrl: 'x' }),
    ev({ title: 'Festival Parade with Fireworks and Live Music', category: 'Festivals', imageUrl: 'x' }),
    ev({ title: 'Classic Car Show and Shine', category: 'Cars & bikes', imageUrl: 'x' }),
  ].map(photoScore);
  for (const score of stacked) assert.ok(score < 100, `${score} should leave headroom`);
  assert.ok(new Set(stacked).size > 1, 'and they should not all be the same number');
});

/** Negatives are deliberately not capped, so the dullest things reach nothing. */
test('an online event is nothing, and a dull one gets there by adding up', () => {
  assert.equal(photoScore(ev({ title: 'Anything at all', category: 'Motorsport', isOnline: true })), 0);
  assert.equal(photoScore(ev({ title: 'AGM and training seminar', category: 'Event' })), 0);
});

test('the range is respected whatever the words', () => {
  for (const e of [
    ev({ title: 'festival parade fireworks airshow balloon carnival market concert', category: 'Festivals', imageUrl: 'x' }),
    ev({ title: 'webinar zoom virtual class seminar networking bingo trivia', category: 'Event' }),
    ev(),
  ]) {
    const score = photoScore(e);
    assert.ok(score >= 0 && score <= 100, `${score} out of range`);
    assert.ok(Number.isFinite(score));
  }
});
