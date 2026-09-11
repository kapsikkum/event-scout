import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crawlerConfigFrom } from '../src/sources/crawler.js';
import { DEFAULT_SETTINGS } from '../src/sources/types.js';

/**
 * The gap this closes: only the extra search terms used to be passed, and
 * with those empty — the usual case — the crawler fell back on a generic list
 * of its own and ignored every topic that had been chosen.
 */
test('the crawler searches for the topics chosen in Settings, in every area', () => {
  const config = crawlerConfigFrom({
    ...DEFAULT_SETTINGS,
    city: 'Bathurst',
    eventAreas: [{ name: 'Orange NSW' }, { name: 'bathurst' }],
    eventTopics: ['motorsport'],
    webSearchTerms: ['Bathurst 1000'],
  });
  assert.deepEqual(config.interests.map((i) => i.city), ['Bathurst', 'Orange NSW'], 'each area once');
  const terms = config.interests[0].terms;
  assert.ok(terms.length > 1, 'the topic expanded into its terms');
  assert.ok(terms.includes('Bathurst 1000'), 'extra terms ride along');
  assert.ok(terms.every((t) => !t.includes('Orange')), 'terms go over bare; the crawler adds the place');
  assert.deepEqual(config.interests[1].terms, terms, 'every area gets the same list');
});

test('only real web addresses are pinned, and each once', () => {
  const config = crawlerConfigFrom({
    ...DEFAULT_SETTINGS,
    city: 'Bathurst',
    crawlerUrls: ['https://a.com/whats-on', '  https://a.com/whats-on  ', 'ftp://b.com', 'not a url', ''],
  });
  assert.deepEqual(config.seeds, ['https://a.com/whats-on']);
});

test('no location means nowhere to search', () => {
  assert.deepEqual(crawlerConfigFrom({ ...DEFAULT_SETTINGS, city: '' }).interests, []);
});
