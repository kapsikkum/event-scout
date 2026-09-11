import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CrawlerRow, crawlerRowKey, planCollapse } from '../src/crawlerRows.js';

const row = (over: Partial<CrawlerRow>): CrawlerRow => ({
  id: 1,
  source_id: 'crawl:https://allevents.in/blacktown/meetups#tuned. sunset meet|2026-09-24T14:00:00.000Z',
  url: 'https://allevents.in/blacktown/tuned-sunset-meet/200029694338424',
  title: 'Tuned. SUNSET MEET',
  start_time: '2026-09-24T14:00:00.000Z',
  starred: 0,
  hidden: 0,
  manual_group: '',
  edits: '',
  edit_photo_score: null,
  ...over,
});

test('one event read off many pages folds into one row, under the new key', () => {
  const rows = [
    row({ id: 1 }),
    row({ id: 2, source_id: 'crawl:https://allevents.in/castle-hill/meetups#tuned. sunset meet|2026-09-24T14:00:00.000Z' }),
    row({ id: 3, source_id: 'crawl:https://allevents.in/dural/meetups#tuned. sunset meet|2026-09-24T14:00:00.000Z' }),
  ];
  const [plan] = planCollapse(rows);
  assert.equal(plan.keep, 1);
  assert.deepEqual(plan.remove, [2, 3]);
  assert.equal(plan.key, crawlerRowKey(rows[0]));
  assert.equal(plan.key, 'crawl:https://allevents.in/blacktown/tuned-sunset-meet/200029694338424#tuned. sunset meet|2026-09-24T14:00:00.000Z');
});

test('the row someone touched is the one kept, and stars and removals carry over', () => {
  const plans = planCollapse([
    row({ id: 1, hidden: 1 }),
    row({ id: 2, source_id: 'crawl:b', edits: 'My title' }),
    row({ id: 3, source_id: 'crawl:c', starred: 1 }),
  ]);
  assert.equal(plans[0].keep, 1, 'the first touched row, by id');
  assert.equal(plans[0].starred, 1);
  assert.equal(plans[0].hidden, 1);
});

test('different events stay apart, and a row already under its key is left alone', () => {
  const alone = row({ id: 9 });
  const already = row({ id: 10, title: 'Other meet', source_id: '' });
  already.source_id = crawlerRowKey(already);
  const plans = planCollapse([alone, already]);
  assert.equal(plans.length, 1, 'only the old-keyed one needs renaming');
  assert.equal(plans[0].keep, 9);
  assert.deepEqual(plans[0].remove, []);
});
