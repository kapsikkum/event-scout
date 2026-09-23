import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyEvent, EVENT_TOPICS } from '../src/sources/topics.js';

test('cars hints do not contain bare word shine', () => {
  const cars = EVENT_TOPICS.find((t) => t.key === 'cars')!;
  assert.ok(!cars.hints?.includes('shine'), 'bare shine removed from hints');
  assert.ok(cars.terms.includes('show and shine'), 'show and shine remains in terms');
  assert.ok(cars.hints?.includes("show 'n' shine"), "show 'n' shine added to hints");
  assert.ok(cars.hints?.includes('car & bike show'), 'car & bike show added to hints');
});

test('music hints include new tour patterns, instruments, genres, iconic bands', () => {
  const music = EVENT_TOPICS.find((t) => t.key === 'music')!;
  assert.ok(music.hints?.includes('world tour'));
  assert.ok(music.hints?.includes('live in concert'));
  assert.ok(music.hints?.includes('guitar'));
  assert.ok(music.hints?.includes('symphony'));
  assert.ok(music.hints?.includes('heavy metal'));
  assert.ok(music.hints?.includes('pink floyd'));
});

test('nightlife hints include rave, dj set, etc.', () => {
  const nightlife = EVENT_TOPICS.find((t) => t.key === 'nightlife')!;
  assert.ok(nightlife.hints?.includes('rave'));
  assert.ok(nightlife.hints?.includes('dj set'));
  assert.ok(nightlife.hints?.includes('silent disco'));
});

test('arts hints include comedy, stand up, theatre, ballet, etc.', () => {
  const arts = EVENT_TOPICS.find((t) => t.key === 'arts')!;
  assert.ok(arts.hints?.includes('comedy'));
  assert.ok(arts.hints?.includes('stand up'));
  assert.ok(arts.hints?.includes('theatre'));
  assert.ok(arts.hints?.includes('ballet'));
});

test('motorsport hints include rally, dragway, motocross, etc.', () => {
  const ms = EVENT_TOPICS.find((t) => t.key === 'motorsport')!;
  assert.ok(ms.hints?.includes('rally'));
  assert.ok(ms.hints?.includes('dragway'));
  assert.ok(ms.hints?.includes('superbike'));
});

test('automotive anchor requirement prevents non-automotive events from becoming Cars & bikes or Motorsport', () => {
  // Harbour cruise without automotive anchors
  const result = classifyEvent('Sydney Harbour Cruise', 'Enjoy dinner on the water with live views', '');
  assert.notEqual(result, 'Cars & bikes');

  // Car show with automotive anchor
  const carShow = classifyEvent('Annual Car Show', 'Great vintage cars on display', '');
  assert.equal(carShow, 'Cars & bikes');

  // Show and shine with 2+ word automotive phrase
  const showShine = classifyEvent('Annual Show and Shine', 'Displays and trophies', '');
  assert.equal(showShine, 'Cars & bikes');
});

test('venue context prior boosts live music and arts for theatres/auditoriums', () => {
  // Title mentions an ambiguous phrase or performer
  const concert = classifyEvent('Evening Gala', 'An intimate evening of performance', '', 'Sydney Opera House');
  assert.ok(concert === 'Live music' || concert === 'Arts & culture');
});

test('venue context prior boosts motorsport for circuits and raceways', () => {
  const race = classifyEvent('Sprint Trophy 2026', 'Round 3 of the racing championship', '', 'Sydney Dragway');
  assert.equal(race, 'Motorsport');
});

test('source category boost awards points when valid sourceCategory matches topic', () => {
  const musicEvent = classifyEvent('Weekend Special', 'Special guest appearance', 'Concert');
  assert.equal(musicEvent, 'Live music');
});

test('specificity weighting favours multi-word phrases over single words', () => {
  // 3+ word phrase "car and bike show" (25 pts) in title beats a single word like "party" (8 pts)
  const result = classifyEvent('Car and Bike Show Party', 'Come along', '');
  assert.equal(result, 'Cars & bikes');
});
