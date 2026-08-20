import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultRegionFrom, expandRegion, isPostcode, localityOf } from '../src/regions.js';
import { cleanAddress, titleCaseShouting } from '../src/validate.js';
import { localitiesFrom, unifyVenueNames } from '../src/venues.js';

/**
 * The address handling was written against Bathurst data and quietly assumed
 * Australia. These are the cases that would have been wrong for anyone else —
 * in particular a user in Nova Scotia, whose "NS" is not a truncation of
 * anything and was being rewritten to "NSW".
 */

test('a region is only expanded when it is short for the local one', () => {
  assert.equal(expandRegion('NS', 'NSW'), 'NSW', 'truncated in New South Wales');
  assert.equal(expandRegion('NS', 'NS'), 'NS', 'already complete in Nova Scotia');
  assert.equal(expandRegion('NS', 'CO'), 'NS', 'unrelated to the local region');
  assert.equal(expandRegion('NS', ''), 'NS', 'no local region agreed on, so no guess');
  assert.equal(expandRegion('CO', 'CO'), 'CO');
});

test('the local region is read off the addresses rather than assumed', () => {
  assert.equal(defaultRegionFrom(['1 A St, Bathurst NSW 2795', '2 B St, Orange NSW 2800']), 'NSW');
  assert.equal(defaultRegionFrom(['12 Barrington St, Halifax NS B3J 1Z1', '5 Spring Garden Rd, Halifax NS']), 'NS');
  assert.equal(defaultRegionFrom(['100 Larimer St, Denver CO 80202']), 'CO');
  assert.equal(defaultRegionFrom(['somewhere unhelpful']), '');
});

test('postcodes are recognised in the shapes the app will meet', () => {
  assert.ok(isPostcode('2795'), 'Australia');
  assert.ok(isPostcode('80202'), 'United States');
  assert.ok(isPostcode('11201-1234'), 'United States plus-four');
  assert.ok(isPostcode('B3J 1Z1'), 'Canada');
  assert.ok(isPostcode('SW1A 1AA'), 'United Kingdom');
  assert.ok(!isPostcode('Bathurst'));
  assert.ok(!isPostcode('NSW'));
});

test('the locality is found regardless of postal convention', () => {
  assert.equal(localityOf('76 Bentinck Street, Bathurst, NSW, 2795'), 'Bathurst');
  assert.equal(localityOf('100 Larimer St, Denver, CO 80202, United States'), 'Denver');
  assert.equal(localityOf('12 Barrington St, Halifax NS B3J 1Z1, Canada'), 'Halifax');
  assert.equal(localityOf('221B Baker Street, London, NW1 6XE, United Kingdom'), 'London');
  assert.equal(localityOf('169 College Road'), '', 'a street alone names no locality');
});

test('a Nova Scotian address survives the cleanup unchanged', () => {
  const halifax = '12 Barrington St, Halifax NS B3J 1Z1, Canada';
  assert.equal(cleanAddress(halifax, 'NS'), halifax);
});

test('the duplicated-tail repair works the same in Denver', () => {
  assert.equal(
    cleanAddress('100 Larimer St, Denver CO 80202, United States, Denver, CO', 'CO'),
    '100 Larimer St, Denver CO 80202, United States'
  );
});

test('venue unification works off whatever localities the data names', () => {
  const localities = localitiesFrom(['Denver CO'], [
    '1 A St, Denver, CO, 80202',
    '2 B St, Denver, CO, 80202',
    '3 C St, Denver, CO, 80202',
  ]);
  assert.ok(localities.has('denver'));
  assert.ok(!localities.has('co'), 'the region is not a locality');
  const map = unifyVenueNames(
    [
      { name: 'Red Rocks Amphitheatre', count: 4 },
      { name: 'Red Rocks Amphitheatre Denver', count: 1 },
    ],
    localities
  );
  assert.equal(map.get('Red Rocks Amphitheatre Denver'), 'Red Rocks Amphitheatre');
});

test('a shouted name is restored, acronyms and brands left alone', () => {
  assert.equal(titleCaseShouting('169 COLLEGE ROAD'), '169 College Road');
  assert.equal(titleCaseShouting('BATHURST RSL CLUB'), 'Bathurst RSL Club');
  assert.equal(titleCaseShouting('FIT4ALL'), 'FIT4ALL', 'a brand, not a sentence');
  assert.equal(titleCaseShouting('Mount Panorama'), 'Mount Panorama', 'not shouting, so untouched');
  assert.equal(titleCaseShouting('Bathurst RSL Club'), 'Bathurst RSL Club');
});

test('a street address sitting in the venue field still yields its locality', () => {
  // Several sources fill venue_name with the street address and leave address
  // empty. Those rows head their own group by street number unless the
  // locality is read out of the venue field as well.
  assert.equal(localityOf('105 William Street, Bathurst, NSW, Australia'), 'Bathurst');
  assert.equal(localityOf('11 Corporation Ave, Robin Hill NSW 2795, Australia'), 'Robin Hill');
  assert.equal(localityOf('127 - 141 Station Street, Penrith'), 'Penrith');
  assert.equal(localityOf('73A Hill St, Orange NSW 2800, Australia'), 'Orange');
});
