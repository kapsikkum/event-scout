import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anchorQueries, coordsDisagree, isPlace, pickHit, placeQueries, statedOf, textAnchorQuery } from '../src/locate.js';

const BATHURST = { lat: -33.4166, lng: 149.5804, radiusKm: 50 };
const PENRITH = { lat: -33.751, lng: 150.694, radiusKm: 25 };
const areas = [BATHURST, PENRITH];
const SLACK = 1.5;

// The results that caused this: a search for the town with an area's name on
// the end finds a street in the area named after the town.
const darwinDrive = { displayName: 'Darwin Drive, Llanarth, Bathurst, New South Wales, 2795, Australia', lat: -33.3975, lng: 149.5517 };
const darwin = { displayName: 'Darwin, Northern Territory, 0800, Australia', lat: -12.4604, lng: 130.841 };

test('the town a listing names is asked about on its own, region first', () => {
  assert.deepEqual(anchorQueries(statedOf('', 'Hidden Valley Raceway, Darwin, NT')), ['Darwin, nt', 'Darwin']);
  assert.deepEqual(anchorQueries(statedOf('Mount Panorama', '')), ['Mount Panorama']);
  assert.deepEqual(anchorQueries({ region: '', locality: '' }), [], 'nothing to anchor on');
});

test('no area name is stapled onto a listing that names its town', () => {
  const stated = statedOf('Hidden Valley Raceway', 'Hidden Valley Raceway, Darwin, NT');
  const queries = placeQueries('Hidden Valley Raceway', 'Hidden Valley Raceway, Darwin, NT', stated, [{ name: 'Bathurst' }]);
  assert.ok(queries.length > 0);
  assert.ok(!queries.some((q) => /bathurst/i.test(q)), `asked ${JSON.stringify(queries)}`);
});

test('a listing that names no town is tried in each area, as it always was', () => {
  const stated = statedOf('', '169 College Road');
  assert.deepEqual(placeQueries('', '169 College Road', stated, [{ name: 'Bathurst' }, { name: 'Orange NSW' }]), [
    '169 College Road, Bathurst',
    '169 College Road, Orange NSW',
  ]);
});

test('a result far from the town it names is refused, however close to home it is', () => {
  // The whole bug in one assertion: Darwin Drive is 3 km away and wrong.
  assert.equal(pickHit([darwinDrive], { region: '', anchor: darwin, areas, slack: SLACK }), null);
  const hiddenValley = { displayName: 'Hidden Valley Raceway, Northern Territory, Australia', lat: -12.5, lng: 131.0 };
  assert.equal(pickHit([darwinDrive, hiddenValley], { region: '', anchor: darwin, areas, slack: SLACK }), hiddenValley);
});

test('without a town to anchor on, only a result inside an area counts', () => {
  const inTown = { displayName: 'College Road, Bathurst, New South Wales, Australia', lat: -33.42, lng: 149.58 };
  const abroad = { displayName: 'College Road, Durham, North Carolina, United States', lat: 36.0, lng: -78.9 };
  assert.equal(pickHit([abroad, inTown], { region: '', anchor: null, areas, slack: SLACK }), inTown);
  assert.equal(pickHit([abroad], { region: '', anchor: null, areas, slack: SLACK }), null);
});

test('a result in another state is refused when the listing names its own', () => {
  const eltham = { displayName: 'Bolton Street, Eltham, Victoria, 3095, Australia', lat: -37.71, lng: 145.15 };
  const bathurst = { displayName: 'Bolton Street, Bathurst, New South Wales, Australia', lat: -33.41, lng: 149.58 };
  assert.equal(pickHit([bathurst, eltham], { region: 'vic', anchor: null, areas, slack: SLACK }), null, 'neither is in an area');
  assert.equal(pickHit([bathurst, eltham], { region: 'vic', anchor: eltham, areas, slack: SLACK }), eltham);
});

test('stored coordinates that contradict the town are not believed', () => {
  assert.equal(coordsDisagree({ lat: darwinDrive.lat, lng: darwinDrive.lng }, darwin), true);
  assert.equal(coordsDisagree({ lat: -12.47, lng: 130.85 }, darwin), false, 'the other side of Darwin is still Darwin');
  assert.equal(coordsDisagree({ lat: 0, lng: 0 }, null), false, 'no town named, nothing to contradict');
});

test('a venue field that is really a shout gets one last try as text', () => {
  const shout = statedOf('MXGP DARWIN AUSTRALIA', '');
  assert.equal(textAnchorQuery('MXGP DARWIN AUSTRALIA', '', shout), 'MXGP DARWIN AUSTRALIA');
  const named = statedOf('', '12 Main St, Orange, NSW');
  assert.equal(textAnchorQuery('', '12 Main St, Orange, NSW', named), '', 'a real town needs no guessing');
  assert.equal(textAnchorQuery('', '', { region: '', locality: '' }), '');
});

test('only a populated place may anchor a listing', () => {
  assert.equal(isPlace({ ...darwin, kind: 'place:city' }), true);
  assert.equal(isPlace({ ...darwinDrive, kind: 'highway:residential' }), false);
  assert.equal(isPlace({ ...darwin, kind: 'amenity:pub' }), false);
  assert.equal(isPlace(darwin), true, 'an older cached answer is allowed');
});
