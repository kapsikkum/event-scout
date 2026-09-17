import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tidyFind } from '../src/tidy.js';

const now = new Date('2026-09-17T00:00:00.000Z');
const base = {
  sourceId: 'x', title: 'Swap Meet', startTime: '2026-09-20T00:00:00.000Z',
  foundAt: now.toISOString(), foundOn: 'https://example.com/',
};

test('a find is tidied into plain text, and placeholders are dropped', () => {
  const ev = tidyFind({
    ...base,
    title: '  Rock &amp; Roll <b>Night</b>\n',
    description: '<p>Bands&nbsp;all night</p><p>Free entry</p>',
    venueName: 'TBA',
    address: '  12 Main St,\n Orange ',
    priceText: '&#36;10',
  }, now)!;
  assert.equal(ev.title, 'Rock & Roll Night');
  assert.equal(ev.description, 'Bands all night\n\nFree entry');
  assert.equal(ev.venueName, undefined);
  assert.equal(ev.address, '12 Main St, Orange');
  assert.equal(ev.priceText, '$10');
  assert.equal('lat' in ev, false, 'nothing added that the page did not say');
});

test('a find that cannot be believed is dropped or loses what cannot', () => {
  assert.equal(tidyFind({ ...base, title: '📅 !!' }, now), null, 'no words in the title');
  assert.equal(tidyFind({ ...base, startTime: '2025-01-01T00:00:00.000Z' }, now), null, 'long past');
  const ev = tidyFind({ ...base, endTime: '2026-09-19T00:00:00.000Z', lat: 0, lng: 0, url: 'javascript:alert(1)' }, now)!;
  assert.equal(ev.endTime, undefined, 'an end before the start');
  assert.equal(ev.lat, undefined, 'an empty map pin');
  assert.equal(ev.url, undefined);
});
