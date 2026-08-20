/**
 * Reading the country-specific parts of an address without hardcoding a country.
 *
 * The first version of the address cleanup was written against Bathurst data
 * and assumed Australia throughout: it expanded a truncated "NS" to "NSW",
 * recognised only Australian states, and only cut a trailing search area off
 * after the word "Australia". The first of those is not merely narrow, it is
 * wrong elsewhere — "NS" is Nova Scotia — so anyone scouting from Halifax
 * would have had their addresses quietly relabelled.
 *
 * What replaces it: recognise regions and postcodes across the countries a
 * user might plausibly be in, and take the *local* convention from the user's
 * own data rather than from a constant here.
 */

/** Country names that end a postal address. */
const COUNTRIES = new Set(
  [
    'australia', 'new zealand', 'united states', 'united states of america', 'usa', 'us',
    'canada', 'united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales',
    'northern ireland', 'ireland', 'france', 'germany', 'spain', 'italy', 'netherlands',
    'belgium', 'switzerland', 'austria', 'sweden', 'norway', 'denmark', 'finland',
    'portugal', 'poland', 'japan', 'singapore', 'india', 'south africa', 'mexico', 'brazil',
  ].map((c) => c.toLowerCase())
);

/**
 * Region names and abbreviations, for recognition only.
 *
 * No attempt is made to tell WA (Western Australia) from WA (Washington), or
 * NT (Northern Territory) from NT (Northwest Territories) — nothing here needs
 * to. The question asked of this set is always "is this component a region
 * rather than a suburb", and the answer is the same either way.
 */
const REGIONS = new Set(
  [
    // Australia
    'nsw', 'new south wales', 'vic', 'victoria', 'qld', 'queensland', 'sa', 'south australia',
    'wa', 'western australia', 'tas', 'tasmania', 'nt', 'northern territory', 'act',
    'australian capital territory',
    // New Zealand
    'auckland', 'wellington', 'canterbury', 'otago', 'waikato',
    // Canada
    'on', 'ontario', 'qc', 'quebec', 'bc', 'british columbia', 'ab', 'alberta', 'mb',
    'manitoba', 'sk', 'saskatchewan', 'ns', 'nova scotia', 'nb', 'new brunswick', 'nl',
    'newfoundland and labrador', 'pe', 'prince edward island', 'yt', 'yukon', 'nu', 'nunavut',
    // United States
    'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia',
    'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
    'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt',
    'va', 'wv', 'wi', 'wy', 'dc',
    // United Kingdom
    'greater london', 'west midlands', 'greater manchester', 'merseyside', 'west yorkshire',
    'south yorkshire', 'tyne and wear',
  ].map((r) => r.toLowerCase())
);

export function isCountry(component: string): boolean {
  return COUNTRIES.has(component.trim().toLowerCase());
}

export function isRegion(component: string): boolean {
  return REGIONS.has(component.trim().toLowerCase());
}

/**
 * Postcodes, in the shapes the app is likely to meet.
 *
 * Australia and New Zealand use four digits, the United States five (with an
 * optional plus-four), and the United Kingdom and Canada an alphanumeric
 * pattern. Anything matching is a postcode rather than a place name.
 */
export function isPostcode(component: string): boolean {
  const text = component.trim();
  if (/^\d{3,6}(-\d{4})?$/.test(text)) return true;
  // Canada: K1A 0B1. United Kingdom: SW1A 1AA, M1 1AE, CR2 6XH.
  if (/^[A-Za-z]\d[A-Za-z][ ]?\d[A-Za-z]\d$/.test(text)) return true;
  if (/^[A-Za-z]{1,2}\d[A-Za-z\d]?[ ]?\d[A-Za-z]{2}$/.test(text)) return true;
  return false;
}

/**
 * The region the user's own events are in, taken from the addresses already
 * stored rather than from a setting.
 *
 * This is what makes the truncation repair portable. A source that cuts its
 * region field to two characters produces "NS" in Sydney and "Ne" in Reno,
 * and neither can be expanded safely without knowing where the user is — but
 * the surrounding addresses know: whatever region they name most often is it.
 * Returns '' when the addresses do not agree on one, in which case nothing is
 * expanded, which is the right answer rather than a guess.
 */
export function defaultRegionFrom(addresses: string[]): string {
  const counts = new Map<string, number>();
  for (const address of addresses) {
    for (const raw of address.split(/[,\s]+/)) {
      const part = raw.trim();
      if (part.length < 2 || !isRegion(part)) continue;
      // Only a full abbreviation can be the target of an expansion, and the
      // long forms ("New South Wales") are split across tokens here anyway.
      const key = part.toUpperCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = '';
  let bestCount = 0;
  for (const [region, count] of counts) {
    if (count > bestCount || (count === bestCount && region < best)) {
      best = region;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : '';
}

/**
 * Repair a region field that a source cut short.
 *
 * Only a strict prefix of the local region expands, so "NS" becomes "NSW" for
 * a user whose events are in New South Wales and stays "NS" for one whose
 * events are in Nova Scotia — where NS is not truncated at all, but complete.
 */
export function expandRegion(component: string, defaultRegion: string): string {
  const text = component.trim();
  if (!defaultRegion || text.length >= defaultRegion.length) return text;
  return defaultRegion.toUpperCase().startsWith(text.toUpperCase()) ? defaultRegion : text;
}

/**
 * The locality (suburb, town, city) an address names, or '' if it names none.
 *
 * Reads from the end and discards what it recognises — the country, a region
 * in any of its spellings, a postcode — because that tail is fixed in every
 * postal convention while the head is not. The first real component left is
 * the locality. A street is rejected rather than returned: grouping events by
 * street number scatters one suburb across a dozen headings.
 */
export function localityOf(address: string): string {
  const parts = address
    .split(',')
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    // "Robin Hill NSW 2795" and "Brooklyn NY 11201" are one comma-free
    // component carrying all three fields.
    .map((p) => stripRegionAndPostcode(p));

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part || isRegion(part) || isPostcode(part) || isCountry(part)) continue;
    if (/^\d/.test(part) || STREET_WORD.test(part)) return '';
    return part;
  }
  return '';
}

const STREET_WORD =
  /\b(st|street|rd|road|ave|avenue|dr|drive|ln|lane|hwy|highway|pde|parade|cres|crescent|pl|place|ct|court|tce|terrace|way|straight|circuit|loop|close|blvd|boulevard)$/i;

/** Strip a trailing "<region> <postcode>" from a single address component. */
export function stripRegionAndPostcode(component: string): string {
  const words = component.trim().split(/\s+/);
  while (words.length > 1) {
    const last = words[words.length - 1];
    const lastTwo = words.slice(-2).join(' ');
    if (isPostcode(last) || isRegion(last)) words.pop();
    else if (words.length > 2 && (isPostcode(lastTwo) || isRegion(lastTwo))) words.splice(-2, 2);
    else break;
  }
  return words.join(' ');
}
