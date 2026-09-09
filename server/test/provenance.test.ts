import { test } from 'node:test';
import assert from 'node:assert/strict';

// merge.js, not events.js: the latter opens the database at import, and these
// tests need nothing but rows.
import { chooseFields } from '../src/merge.js';
import type { EventRow } from '../src/merge.js';

/**
 * Which of the three opinions a reader is actually looking at.
 *
 * The columns have always been kept apart in the database, but the merge
 * flattens them, and a rewritten blurb reaching a card looks exactly like one
 * the organiser wrote. These check the label that says which is which.
 */
function row(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    source: 'MIDNIGHT_SPEC',
    source_id: 'x1',
    title: 'Bathurst Weekend Run',
    description: 'Come along!! #cars link in bio',
    start_time: '2026-09-25T09:00:00.000Z',
    end_time: null,
    venue_name: '',
    address: '',
    lat: null,
    lng: null,
    url: 'https://example.test/1',
    image_url: '',
    category: 'General',
    price_text: '',
    is_online: 0,
    photo_score: 60,
    archived: 0,
    archived_at: null,
    starred: 0,
    hidden: 0,
    dedupe_group: 'g1',
    manual_group: '',
    llm_description: '',
    llm_category: '',
    llm_venue_name: '',
    llm_address: '',
    llm_price_text: '',
    llm_photo_score: null,
    vision_venue_name: '',
    vision_address: '',
    vision_price_text: '',
    vision_note: '',
    ...over,
  };
}

/**
 * The state the app is in with the tasks switched off, which is most of the
 * time. Nothing may be labelled, because nothing was touched.
 */
test('an unenriched listing claims nothing', () => {
  const chosen = chooseFields([row()]);
  assert.deepEqual(chosen.enriched, {});
  assert.equal(chosen.description, 'Come along!! #cars link in bio');
  assert.equal(chosen.category, 'General');
});

test('a rewritten blurb and a re-filed category are both owned up to', () => {
  const chosen = chooseFields([
    row({ llm_description: 'A drive over Mount Panorama.', llm_category: 'Motorsport' }),
  ]);
  assert.equal(chosen.description, 'A drive over Mount Panorama.');
  assert.equal(chosen.category, 'Motorsport');
  assert.deepEqual(chosen.enriched, { description: 'model', category: 'model' });
});

/**
 * The distinction that matters most. A venue the source stated is not the
 * model's to claim, however much it also had to say about it.
 */
test('a field the source stated is neither taken nor claimed', () => {
  const chosen = chooseFields([
    row({
      venue_name: 'Mount Panorama',
      address: '1 Mountain Straight',
      llm_venue_name: 'Panorama Circuit',
      llm_address: 'Bathurst NSW 2795',
      vision_venue_name: 'MT PANORAMA',
    }),
  ]);
  assert.equal(chosen.venueName, 'Mount Panorama', 'the scraped value wins');
  assert.equal(chosen.address, '1 Mountain Straight');
  assert.deepEqual(chosen.enriched, {}, 'and nothing is labelled');
});

test('a blank is filled from the flyer before the text model, and says which', () => {
  const fromFlyer = chooseFields([
    row({ vision_venue_name: 'Shannons Artarmon', llm_venue_name: 'Artarmon' }),
  ]);
  assert.equal(fromFlyer.venueName, 'Shannons Artarmon');
  assert.deepEqual(fromFlyer.enriched, { venueName: 'flyer' });

  const fromModel = chooseFields([row({ llm_address: 'Bathurst NSW' })]);
  assert.equal(fromModel.address, 'Bathurst NSW');
  assert.deepEqual(fromModel.enriched, { address: 'model' });
});

/** Only ever the vision pass, so it is labelled whenever it is there at all. */
test('a note off the flyer is always the flyer', () => {
  assert.deepEqual(chooseFields([row({ vision_note: 'Gates open 4:30pm' })]).enriched, { note: 'flyer' });
  assert.deepEqual(chooseFields([row({ vision_note: '' })]).enriched, {});
});

/**
 * The score is blended rather than replaced, so the label means "a model had a
 * say", not "a model decided". Worth marking even so: half of a shown number
 * coming from a model is the thing a reader would want to know.
 */
test('the score is marked when a model had a say, and not when it did not', () => {
  const judged = chooseFields([row({ photo_score: 60, llm_photo_score: 80 })]);
  assert.equal(judged.photoScore, 70, 'the average of the two');
  assert.deepEqual(judged.enriched, { photoScore: 'model' });

  const unjudged = chooseFields([row({ photo_score: 60, llm_photo_score: null })]);
  assert.equal(unjudged.photoScore, 60);
  assert.deepEqual(unjudged.enriched, {});
});

/**
 * A zero is a verdict, not a missing one — the model is asked to put webinars
 * and AGMs down there. Treated as absent it would go unlabelled.
 */
test('a score of zero still counts as the model having answered', () => {
  const chosen = chooseFields([row({ photo_score: 20, llm_photo_score: 0 })]);
  assert.equal(chosen.photoScore, 10);
  assert.deepEqual(chosen.enriched, { photoScore: 'model' });
});

/** Across a merged pair, one member's reading fills the other's blank. */
test('a merged event inherits a label along with the value', () => {
  const chosen = chooseFields([
    row({ id: 1, venue_name: '' }),
    row({ id: 2, venue_name: '', vision_venue_name: 'Shannons Artarmon' }),
  ]);
  assert.equal(chosen.venueName, 'Shannons Artarmon');
  assert.deepEqual(chosen.enriched, { venueName: 'flyer' });
});
