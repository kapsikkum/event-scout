import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseFields, EditError, EDITABLE_FIELDS, parseEditPatch } from '../src/merge.js';
import type { EventRow } from '../src/merge.js';

function row(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 1, source: 'midnightspec', source_id: 'x1',
    title: 'Repco Bathurst 1000', description: 'Come along!!',
    start_time: '2026-10-07T23:00:00.000Z', end_time: null,
    venue_name: 'Bathurst', address: 'Bathurst, NSW',
    lat: null, lng: null, url: 'https://example.test/1',
    image_url: 'https://images.example.test/enduro-cup.jpg',
    category: 'Motorsport', price_text: '', is_online: 0, photo_score: 15,
    archived: 0, archived_at: null, starred: 0, hidden: 0,
    dedupe_group: 'g1', manual_group: '',
    llm_description: '', llm_category: '', llm_venue_name: '', llm_address: '',
    llm_price_text: '', llm_photo_score: null,
    vision_venue_name: '', vision_address: '', vision_price_text: '', vision_note: '',
    edit_title: '', edit_description: '', edit_start_time: '', edit_venue_name: '',
    edit_address: '', edit_category: '', edit_price_text: '', edit_image_url: '',
    edit_photo_score: null,
    ...over,
  };
}

// --- what an edit does to what you see -------------------------------------

test('an untouched event reports nothing edited', () => {
  const chosen = chooseFields([row()]);
  assert.deepEqual(chosen.edited, []);
  assert.equal(chosen.venueName, 'Bathurst');
  assert.equal(chosen.imageUrl, null, 'no override means use the listing images');
});

/**
 * The point of the whole feature: what you typed wins, over the scraper, the
 * flyer and the model alike.
 */
test('a hand edit beats every other opinion', () => {
  const chosen = chooseFields([
    row({
      venue_name: 'Bathurst',
      vision_venue_name: 'THE BEND',
      llm_venue_name: 'Bathurst NSW',
      edit_venue_name: 'Mount Panorama',
    }),
  ]);
  assert.equal(chosen.venueName, 'Mount Panorama');
  assert.deepEqual(chosen.edited, ['venueName']);
});

/**
 * A field someone typed is not a field a model wrote. Showing both would put an
 * AI badge over a value the reader put there themselves.
 */
test('editing a field clears its AI marker', () => {
  const before = chooseFields([row({ llm_category: 'Cars & bikes' })]);
  assert.equal(before.enriched.category, 'model');

  const after = chooseFields([row({ llm_category: 'Cars & bikes', edit_category: 'Motorsport' })]);
  assert.equal(after.category, 'Motorsport');
  assert.equal(after.enriched.category, undefined, 'no longer the model’s answer');
  assert.deepEqual(after.edited, ['category']);
});

test('clearing an edit puts back what would have been shown', () => {
  const edited = chooseFields([row({ edit_venue_name: 'Mount Panorama' })]);
  assert.equal(edited.venueName, 'Mount Panorama');
  // '' is what the clear writes, and it must not read as "set to nothing".
  const cleared = chooseFields([row({ edit_venue_name: '' })]);
  assert.equal(cleared.venueName, 'Bathurst');
  assert.deepEqual(cleared.edited, []);
});

/** Zero is a real score, so it has to survive as an override. */
test('a score of zero is an edit, not an absent one', () => {
  const chosen = chooseFields([row({ photo_score: 80, edit_photo_score: 0 })]);
  assert.equal(chosen.photoScore, 0);
  assert.deepEqual(chosen.edited, ['photoScore']);
});

test('an edit applies across every listing behind a merged event', () => {
  const chosen = chooseFields([
    row({ id: 1, edit_title: 'Bathurst 1000' }),
    row({ id: 2, title: 'Bathurst 1000, Mount Panorama', edit_title: 'Bathurst 1000' }),
  ]);
  assert.equal(chosen.title, 'Bathurst 1000');
});

// --- reading the request ----------------------------------------------------

test('only the fields sent are touched', () => {
  const edits = parseEditPatch({ venueName: 'Mount Panorama' });
  assert.deepEqual(edits, [{ field: 'venueName', value: 'Mount Panorama' }]);
});

test('an empty string and null both clear', () => {
  assert.deepEqual(parseEditPatch({ venueName: '' }), [{ field: 'venueName', value: '' }]);
  assert.deepEqual(parseEditPatch({ venueName: null }), [{ field: 'venueName', value: '' }]);
  assert.deepEqual(parseEditPatch({ photoScore: null }), [{ field: 'photoScore', value: null }]);
  assert.deepEqual(parseEditPatch({ photoScore: '' }), [{ field: 'photoScore', value: null }]);
});

/**
 * Stored as the same UTC instant as every other time, or sorting, the past
 * window and the calendar feed would all read it differently from the rest.
 */
test('a start time is normalised to the instant it names', () => {
  assert.deepEqual(parseEditPatch({ startTime: '2026-10-08T11:00:00+11:00' }), [
    { field: 'startTime', value: '2026-10-08T00:00:00.000Z' },
  ]);
  assert.throws(() => parseEditPatch({ startTime: 'next Tuesday' }), EditError);
});

test('a picture has to be a fetchable address', () => {
  assert.deepEqual(parseEditPatch({ imageUrl: ' https://x.test/a.jpg ' }), [
    { field: 'imageUrl', value: 'https://x.test/a.jpg' },
  ]);
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'x.test/a.jpg']) {
    assert.throws(() => parseEditPatch({ imageUrl: bad }), EditError, bad);
  }
  // Clearing it is still allowed.
  assert.deepEqual(parseEditPatch({ imageUrl: '' }), [{ field: 'imageUrl', value: '' }]);
});

test('a score outside the scale is refused', () => {
  assert.deepEqual(parseEditPatch({ photoScore: 72 }), [{ field: 'photoScore', value: 72 }]);
  assert.deepEqual(parseEditPatch({ photoScore: '72.4' }), [{ field: 'photoScore', value: 72 }]);
  for (const bad of [-1, 101, 'lots', NaN, Infinity]) {
    assert.throws(() => parseEditPatch({ photoScore: bad }), EditError, String(bad));
  }
});

test('junk in place of text is refused rather than stringified', () => {
  for (const bad of [7, [], {}, true]) {
    assert.throws(() => parseEditPatch({ venueName: bad }), EditError, JSON.stringify(bad));
  }
});

/** A request naming nothing this app knows is a mistake worth reporting. */
test('a request that changes nothing is refused', () => {
  assert.throws(() => parseEditPatch({}), EditError);
  assert.throws(() => parseEditPatch({ nonsense: 'x', id: 4 }), EditError);
});

test('every editable field can actually be sent', () => {
  for (const field of EDITABLE_FIELDS) {
    const value =
      field === 'photoScore' ? 50
      : field === 'imageUrl' ? 'https://x.test/a.jpg'
      : field === 'startTime' ? '2026-10-08T11:00:00+11:00'
      : 'something';
    assert.deepEqual(parseEditPatch({ [field]: value }).map((e) => e.field), [field]);
  }
});
