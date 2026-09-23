import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Cullable, cullReason, detectNotAnEvent, vetting } from '../src/cull.js';

const bathurst = { name: 'Bathurst', lat: -33.4166, lng: 149.5804, radiusKm: 85 };
const penrith = { name: 'Penrith', lat: -33.751, lng: 150.694, radiusKm: 25 };
const hubs = [bathurst, penrith];
const ON = { cullOutsideAreas: true, excludedCategories: ['Music'] };

function ev(over: Partial<Cullable> = {}): Cullable {
  return {
    lat: null, lng: null, locality: '', area: '', category: 'Motorsport',
    starred: false, unknownLocation: false, sources: [{ source: 'crawler' }], edited: [],
    ...over,
  };
}

// Melbourne: a long way from both.
const melbourne = { lat: -37.8136, lng: 144.9631 };

test('an event far outside every area is culled, and says how far', () => {
  assert.match(cullReason(ev(melbourne), hubs, ON) ?? '', /^\d+ km from Bathurst, the nearest area$/);
});

test('nothing is culled for distance with the setting off', () => {
  assert.equal(cullReason(ev(melbourne), hubs, { cullOutsideAreas: false }), null);
});

test('just over a radius is still in the area', () => {
  // About 100 km west of Bathurst: over 85, under 85 x 1.5.
  assert.equal(cullReason(ev({ lat: -33.42, lng: 148.5 }), hubs, ON), null);
});

test('an event that rounds to one of the towns is in it', () => {
  assert.equal(cullReason(ev({ ...melbourne, area: 'Bathurst' }), hubs, ON), null);
});

test('a town with no coordinates of its own is placed by its last lookup', () => {
  const where = (name: string) => (name === 'Geelong' ? [{ lat: -38.15, lng: 144.36 }] : []);
  assert.ok(cullReason(ev({ locality: 'Geelong' }), hubs, ON, where));
  assert.equal(cullReason(ev({ locality: 'Nowhere' }), hubs, ON, where), null, 'never looked up: left alone');
});

test('a town name that also exists inside an area is given the benefit of it', () => {
  // Kelso, Scotland first, as Nominatim may well rank it; Kelso NSW second.
  const kelso = () => [{ lat: 55.598, lng: -2.433 }, { lat: -33.418, lng: 149.614 }];
  assert.equal(cullReason(ev({ locality: 'Kelso' }), hubs, ON, kelso), null);
});

test('an event with no place at all is never culled for distance', () => {
  assert.equal(cullReason(ev({ unknownLocation: true }), hubs, ON), null);
});

test('starred and hand-added events are never culled', () => {
  assert.equal(cullReason(ev({ ...melbourne, starred: true }), hubs, ON), null);
  assert.equal(cullReason(ev({ ...melbourne, sources: [{ source: 'manual' }] }), hubs, ON), null);
  assert.equal(cullReason(ev({ category: 'Music', starred: true }), hubs, ON), null);
});

test('an excluded category is culled wherever it is, unless it was set by hand', () => {
  assert.equal(cullReason(ev({ category: 'music', area: 'Bathurst' }), hubs, ON), 'Excluded category: music');
  assert.equal(cullReason(ev({ category: 'Music', edited: ['category'] }), hubs, ON), null);
  assert.equal(cullReason(ev({ category: 'Motorsport' }), hubs, ON), null);
});

test('with no area on the map, nothing can be judged far from one', () => {
  assert.equal(cullReason(ev(melbourne), [{ name: 'Somewhere', lat: null, lng: null, radiusKm: 50 }], ON), null);
});

test('the model turning a listing down culls it with its reason, unless starred', () => {
  assert.equal(cullReason(ev({ notEvent: 'a race report' }), hubs, {}), 'Not an event: a race report');
  assert.equal(cullReason(ev({ notEvent: 'a race report', starred: true }), hubs, {}), null);
  assert.equal(cullReason(ev({ pending: true }), hubs, {}), 'Waiting to be checked');
  assert.equal(cullReason(ev({ pending: true, area: 'Bathurst' }), hubs, {}), null);
  assert.equal(cullReason(ev({ pending: true, sources: [{ source: 'manual' }] }), hubs, {}), null);
});

test('vetting: new events wait for the model, a few hours at most', () => {
  const found = '2026-09-17T00:00:00.000Z';
  const at = (h: number): number => Date.parse(found) + h * 3600_000;
  const unread = { llm_vet_note: '', llm_vetted_at: '' };
  assert.deepEqual(vetting([unread], found, true, at(1)), { notEvent: '', pending: true, shownAt: '2026-09-17T06:00:00.000Z' });
  assert.equal(vetting([unread], found, true, at(7)).pending, false, 'shown anyway once the wait is up');
  assert.deepEqual(vetting([unread], found, false, at(1)), { notEvent: '', pending: false, shownAt: found }, 'no waiting with the check off');

  const yes = { llm_vet_note: '', llm_vetted_at: '2026-09-17T00:20:00.000Z' };
  const no = { llm_vet_note: 'a race report', llm_vetted_at: '2026-09-17T00:10:00.000Z' };
  assert.deepEqual(vetting([yes, no], found, true, at(1)), { notEvent: '', pending: false, shownAt: yes.llm_vetted_at }, 'one yes is enough');
  assert.equal(vetting([no, unread], found, true, at(1)).notEvent, 'a race report');

  // An event from before the check existed, read today, is not new today.
  const late = { llm_vet_note: '', llm_vetted_at: '2026-09-20T00:00:00.000Z' };
  assert.equal(vetting([late], found, true, at(80)).shownAt, '2026-09-17T06:00:00.000Z');
});

test('a far town with a heading of its own is still outside every area', () => {
  const armidale = { lat: -30.5145, lng: 151.6657 };
  assert.match(cullReason(ev({ locality: 'Armidale' }), hubs, ON, () => [armidale]) ?? '', /^\d+ km from \w+, the nearest area$/);
});

test('a listing that names a state none of the areas are in is culled', () => {
  const rules = { ...ON, areaRegions: ['nsw'] };
  assert.equal(cullReason(ev({ region: 'qld', locality: 'Toowoomba' }), hubs, rules), 'In Queensland, outside every area');
  assert.equal(cullReason(ev({ region: 'nt' }), hubs, rules), 'In the Northern Territory, outside every area');
  assert.equal(cullReason(ev({ region: 'nsw', locality: 'Armidale' }), hubs, rules), null, 'the same state is judged on distance');
  assert.equal(cullReason(ev({ region: 'qld' }), hubs, ON), null, 'nothing known about the areas, no rule');
  assert.equal(cullReason(ev({ region: 'qld', starred: true }), hubs, rules), null);
});

// ---------- detectNotAnEvent ----------------------------------------------------

test('detectNotAnEvent: homepage titles are detected', () => {
  assert.ok(detectNotAnEvent('Home - Bathurst 6 Hour', undefined, 'https://bathurst6hour.com.au/'), 'homepage dash pattern');
  assert.ok(detectNotAnEvent('Home | Bathurst Cycling Festival', undefined, undefined), 'homepage pipe pattern without URL');
  assert.ok(detectNotAnEvent('Welcome to Bathurst Events', undefined, undefined), 'welcome-to pattern');
  assert.ok(detectNotAnEvent('Homepage – Events', undefined, undefined), 'homepage word');
});

test('detectNotAnEvent: contact page titles are detected', () => {
  assert.ok(detectNotAnEvent('Contact Us', undefined, 'https://bathurstbiggestexpo.com/contact-us/'), 'contact us with url');
  assert.ok(detectNotAnEvent('contact', undefined, undefined), 'lowercase contact');
});

test('detectNotAnEvent: about page titles are detected', () => {
  assert.ok(detectNotAnEvent('About', undefined, 'https://www.bathurst.nsw.gov.au/About'), 'about title');
  assert.ok(detectNotAnEvent('about us', undefined, undefined), 'about us lowercase');
});

test('detectNotAnEvent: site info URL paths are detected', () => {
  assert.ok(detectNotAnEvent('Something', undefined, 'https://example.com/about-us/team'), 'about-us url path');
  assert.ok(detectNotAnEvent('Something', undefined, 'https://example.com/privacy/policy'), 'privacy url path');
  assert.ok(detectNotAnEvent('Something', undefined, 'https://example.com/terms/'), 'terms url path');
  assert.ok(detectNotAnEvent('Something', undefined, 'https://example.com/contact/form'), 'contact url path');
});

test('detectNotAnEvent: volunteer / staff recruitment pages are detected', () => {
  assert.ok(detectNotAnEvent('Volunteer Application - Challenge Bathurst'), 'volunteer application');
  assert.ok(detectNotAnEvent('Motorsport Officials & Volunteers | Challenge Bathurst Event'), 'officials & volunteers');
  assert.ok(detectNotAnEvent('Officials Application - Challenge Bathurst'), 'officials application');
  assert.ok(detectNotAnEvent('Volunteers Needed for the Bathurst 12 Hour'), 'volunteers needed');
  assert.ok(detectNotAnEvent('Call for Volunteers - Bathurst Running Festival'), 'call for volunteers');
  assert.ok(detectNotAnEvent('Marshals Wanted – Bathurst 1000'), 'marshals wanted');
});

test('detectNotAnEvent: vendor / stallholder / grant application pages are detected', () => {
  assert.ok(detectNotAnEvent('Stallholders Application - Bathurst Expo'), 'stallholders application');
  assert.ok(detectNotAnEvent('Stallholder Application'), 'stallholder application');
  assert.ok(detectNotAnEvent('Vendor Application – Markets'), 'vendor application');
  assert.ok(detectNotAnEvent('Exhibitor Application - Motor Show'), 'exhibitor application');
  assert.ok(detectNotAnEvent('Grant Application 2026'), 'grant application');
});

test('detectNotAnEvent: standalone nav section titles are detected', () => {
  assert.ok(detectNotAnEvent('Stallholders'), 'stallholders nav section');
  assert.ok(detectNotAnEvent('Sponsors'), 'sponsors nav section');
  assert.ok(detectNotAnEvent('Volunteers'), 'volunteers nav section');
  assert.ok(detectNotAnEvent('Officials'), 'officials nav section');
  assert.ok(detectNotAnEvent('Marshals'), 'marshals nav section');
});

test('detectNotAnEvent: news / blog / press recaps are detected', () => {
  assert.ok(
    detectNotAnEvent('Engel emotional after Bathurst breakthrough | Bathurst 12 Hour', undefined, 'https://www.bathurst12hour.com.au/news/engel-emotional'),
    'news article with emotional + breakthrough keywords'
  );
  assert.ok(
    detectNotAnEvent('Race Results – Round 3', undefined, 'https://example.com/blog/results-2026'),
    'blog post with results keyword'
  );
  assert.ok(
    detectNotAnEvent('Stunning recap of the Bathurst 1000', undefined, 'https://example.com/press/recap'),
    'press recap'
  );
});

test('detectNotAnEvent: real events return null', () => {
  // Root URL but non-homepage title — should NOT be detected
  assert.equal(detectNotAnEvent('Challenge Bathurst', undefined, 'https://www.challengebathurst.com/'), null, 'real event at root URL');
  // Normal real event titles
  assert.equal(detectNotAnEvent('Echoes of Pink Floyd - Shine On Tour'), null, 'real music event');
  assert.equal(detectNotAnEvent('Repco Bathurst 1000'), null, 'real motorsport event');
  assert.equal(detectNotAnEvent('Bathurst Track Day 2026'), null, 'real track day event');
  // A news URL without recap keywords should NOT be blocked
  assert.equal(
    detectNotAnEvent('Bathurst 12 Hour Preview 2026', undefined, 'https://example.com/news/preview'),
    null,
    'news URL without recap keyword is fine'
  );
});

test('detectNotAnEvent: cullReason uses rule-based detection before LLM notEvent', () => {
  // Should be culled by rule-based detection even without notEvent set
  const homepageEv = ev({ title: 'Home - Bathurst Events', sources: [{ source: 'crawler', url: 'https://bathurst.com/' }] });
  assert.ok(cullReason(homepageEv, hubs, {}), 'homepage detected by rule');

  // A volunteer application page should be culled regardless of LLM
  const volunteerEv = ev({ title: 'Volunteer Application - Bathurst Festival', sources: [{ source: 'crawler' }] });
  assert.ok(cullReason(volunteerEv, hubs, {}), 'volunteer application detected by rule');

  // Starred even with a bad title should never be culled
  const starredEv = ev({ title: 'Home - Bathurst Events', starred: true, sources: [{ source: 'crawler' }] });
  assert.equal(cullReason(starredEv, hubs, {}), null, 'starred events are never culled');

  // Manual source should never be culled
  const manualEv = ev({ title: 'Contact Us', sources: [{ source: 'manual' }] });
  assert.equal(cullReason(manualEv, hubs, {}), null, 'manual source is never culled');
});

