import { test } from 'node:test';
import assert from 'node:assert/strict';

import { geocodeCandidates } from '../src/refresh.js';

const areas = [{ city: 'Bathurst' }, { city: 'Orange NSW' }];

test('an address that names its state is looked up as it is, never with an area added', () => {
  assert.deepEqual(
    geocodeCandidates('Skidpan, Traffic Education Centre', 'Mann Street East, Armidale, NSW, 2350', areas),
    ['Mann Street East, Armidale, NSW, 2350', 'Skidpan, Traffic Education Centre, Mann Street East, Armidale, NSW, 2350', 'Skidpan'],
  );
});

test('a bare street or a venue alone is tried in each area', () => {
  assert.deepEqual(geocodeCandidates('', '169 College Road', areas), ['169 College Road, Bathurst', '169 College Road, Orange NSW']);
  assert.deepEqual(geocodeCandidates('Royal Hotel', '', areas), ['Royal Hotel, Bathurst', 'Royal Hotel, Orange NSW']);
});
