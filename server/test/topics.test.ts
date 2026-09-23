import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CATEGORIES,
  classifyEvent,
  EVENT_TOPICS,
  expandTopics,
  fbQuery,
  GENERAL_CATEGORY,
  rotateQueries,
  webQuery,
} from '../src/sources/topics.js';

test('topic definitions have valid keys, categories, and non-empty terms', () => {
  assert.ok(EVENT_TOPICS.length >= 10, 'expected at least 10 event topics');
  const seenKeys = new Set<string>();
  const seenCategories = new Set<string>();

  for (const topic of EVENT_TOPICS) {
    assert.ok(topic.key.trim().length > 0, `topic key should not be empty: ${JSON.stringify(topic)}`);
    assert.ok(!seenKeys.has(topic.key), `duplicate topic key: ${topic.key}`);
    seenKeys.add(topic.key);

    assert.ok(topic.label.trim().length > 0, `topic label should not be empty: ${topic.key}`);
    assert.ok(topic.category.trim().length > 0, `topic category should not be empty: ${topic.key}`);
    seenCategories.add(topic.category);

    assert.ok(Array.isArray(topic.terms) && topic.terms.length > 0, `topic terms should not be empty: ${topic.key}`);
    for (const term of topic.terms) {
      assert.ok(term.trim().length > 0, `term in topic ${topic.key} should not be empty string`);
    }

    if (topic.hints) {
      for (const hint of topic.hints) {
        assert.ok(hint.trim().length > 0, `hint in topic ${topic.key} should not be empty string`);
      }
    }
  }

  assert.ok(ALL_CATEGORIES.includes(GENERAL_CATEGORY), 'ALL_CATEGORIES must include GENERAL_CATEGORY');
  for (const cat of seenCategories) {
    assert.ok(ALL_CATEGORIES.includes(cat), `ALL_CATEGORIES must include topic category: ${cat}`);
  }
});

test('cars topic does not contain bare "shine" hint', () => {
  const carsTopic = EVENT_TOPICS.find((t) => t.key === 'cars');
  assert.ok(carsTopic, 'cars topic must exist');
  assert.ok(!carsTopic.hints?.includes('shine'), 'bare "shine" must not be in cars hints');
  assert.ok(carsTopic.terms.includes('show and shine'), '"show and shine" should be in cars terms');
});

test('expandTopics formats queries correctly and handles edge cases', () => {
  assert.deepEqual(expandTopics(undefined, 'Bathurst', webQuery), [], 'empty for undefined keys');
  assert.deepEqual(expandTopics([], 'Bathurst', webQuery), [], 'empty for empty keys');
  assert.deepEqual(expandTopics(['motorsport'], '   ', webQuery), [], 'empty for whitespace place');

  const motorsportQueries = expandTopics(['motorsport'], 'Bathurst', webQuery);
  assert.ok(motorsportQueries.length > 0, 'should generate queries for motorsport');
  assert.ok(motorsportQueries.includes('motorsport in Bathurst'));
  assert.ok(motorsportQueries.includes('race meeting in Bathurst'));

  const fbQueries = expandTopics(['motorsport'], 'Bathurst', fbQuery);
  assert.ok(fbQueries.includes('Bathurst motorsport'));
  assert.ok(fbQueries.includes('Bathurst race meeting'));

  // Deduplication check
  const duplicateQueries = expandTopics(['motorsport', 'motorsport'], 'Bathurst', webQuery);
  assert.equal(duplicateQueries.length, motorsportQueries.length, 'queries should be deduplicated');
});

test('rotateQueries rotates within bounds based on timestamp', () => {
  const queries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
  const slice1 = rotateQueries(queries, 3, 0);
  assert.deepEqual(slice1, ['q1', 'q2', 'q3']);

  const hour1 = 3_600_000;
  const slice2 = rotateQueries(queries, 3, hour1);
  assert.deepEqual(slice2, ['q4', 'q5', 'q6']);

  // Short lists are returned whole
  assert.deepEqual(rotateQueries(['q1', 'q2'], 5), ['q1', 'q2']);
});

test('classifyEvent classifies Pink Floyd tribute tour as Live music, NOT Cars & bikes', () => {
  const category = classifyEvent(
    'Echoes of Pink Floyd - Shine On Tour - Bathurst Memorial Entertainment Centre NSW',
    '',
    '',
    'Bathurst Memorial Entertainment Centre'
  );
  assert.equal(category, 'Live music');
});

test('classifyEvent classifies car and bike shows correctly', () => {
  assert.equal(
    classifyEvent('Bathurst Swap Meet, Car and Bike Show'),
    'Cars & bikes'
  );

  assert.equal(
    classifyEvent('SMILE NOW CRY LATER CAR and BIKE SHOW'),
    'Cars & bikes'
  );

  assert.equal(
    classifyEvent('Show and shine', 'Annual Rotary Show and shine car display'),
    'Cars & bikes'
  );

  assert.equal(
    classifyEvent('FORD FALCON TRIBUTE CRUISE #8', '', '', 'Mount Panorama Circuit'),
    'Cars & bikes'
  );
});

test('classifyEvent classifies nightlife and raves correctly', () => {
  const category = classifyEvent('HELLO KITTY RAVE PERTH', '', '', 'The Deen');
  assert.equal(category, 'Nightlife');
});

test('classifyEvent classifies motorsport events with circuit venue correctly', () => {
  const category = classifyEvent('Challenge Bathurst', '', '', 'Mount Panorama Circuit');
  assert.equal(category, 'Motorsport');
});

test('classifyEvent classifies comedy at entertainment centre as Arts & culture', () => {
  const category = classifyEvent(
    'Comedy Night Live',
    'Stand up comedy show with top comedians',
    '',
    'Bathurst Memorial Entertainment Centre'
  );
  assert.equal(category, 'Arts & culture');
});

test('classifyEvent does NOT assign Cars & bikes to events with "shine" without automotive anchors', () => {
  const yogaCat = classifyEvent('Rise and Shine Morning Yoga', 'Start your day with peaceful morning stretches');
  assert.notEqual(yogaCat, 'Cars & bikes');

  const workshopCat = classifyEvent('Shine Bright Leadership Workshop');
  assert.notEqual(workshopCat, 'Cars & bikes');

  const breakfastCat = classifyEvent('Rise and Shine Community Breakfast');
  assert.notEqual(breakfastCat, 'Cars & bikes');
});

test('classifyEvent respects valid sourceCategory when no strong keywords match', () => {
  const cat = classifyEvent('Random Gathering of Friends', '', 'Community');
  assert.equal(cat, 'Community');
});

test('classifyEvent ignores useless sourceCategory and falls back to GENERAL_CATEGORY', () => {
  const cat = classifyEvent('Unknown Event with No Keyword Matches', '', 'Event');
  assert.equal(cat, GENERAL_CATEGORY);

  const fbCat = classifyEvent('Unknown Event with No Keyword Matches', '', 'Facebook');
  assert.equal(fbCat, GENERAL_CATEGORY);
});
