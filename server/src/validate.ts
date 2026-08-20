import { haversineKm } from './dedupe.js';
import { Location, RawEvent } from './sources/types.js';
import { expandRegion, isCountry, stripRegionAndPostcode } from './regions.js';

/**
 * How far into the past a listing's start may sit and still be believed.
 *
 * A day's grace covers events already running and clock skew between a source
 * and us. Anything older is not "an event we caught late" — it is a stale
 * schema.org block on a recurring event's page, which is the single most
 * common way a bad date reaches the database: a weekly market's page carried
 * startDate 2025-08-22 all through 2026, and that year-old Friday was shown
 * as the next occurrence of a Saturday market.
 */
const PAST_GRACE_MS = 36 * 3600 * 1000;

/** Listings further out than this are almost always a mis-parsed year. */
const FUTURE_HORIZON_DAYS = 400;

/**
 * Longest run we will believe for a single listing. Festivals and exhibitions
 * genuinely last weeks; an end 14 months after the start is a page that reuses
 * one JSON-LD block for a whole season of occurrences.
 */
const MAX_DURATION_MS = 21 * 24 * 3600 * 1000;

export interface DateVerdict {
  ok: boolean;
  /** Human-readable cause, for the refresh log. Empty when ok. */
  reason: string;
  startTime: string;
  /** Null when the source's end was not believable and has been dropped. */
  endTime: string | null;
}

/**
 * Sanity-check a listing's dates and repair what can be repaired.
 *
 * Returns the times to store rather than mutating: an unbelievable end is
 * dropped (the event is still real, we just do not know when it finishes),
 * while an unbelievable start rejects the listing outright, because a start is
 * the one field a scouting list cannot work around.
 */
export function validateDates(
  ev: { startTime?: string; endTime?: string },
  now: number = Date.now()
): DateVerdict {
  const fail = (reason: string): DateVerdict => ({ ok: false, reason, startTime: '', endTime: null });

  const start = ev.startTime ? Date.parse(ev.startTime) : NaN;
  if (Number.isNaN(start)) return fail('no parsable start time');
  if (start < now - PAST_GRACE_MS) {
    return fail(`start ${new Date(start).toISOString().slice(0, 10)} is in the past`);
  }
  if (start > now + FUTURE_HORIZON_DAYS * 24 * 3600 * 1000) {
    return fail(`start ${new Date(start).toISOString().slice(0, 10)} is beyond the horizon`);
  }

  let endTime: string | null = null;
  const end = ev.endTime ? Date.parse(ev.endTime) : NaN;
  if (!Number.isNaN(end) && end > start && end - start <= MAX_DURATION_MS) {
    endTime = new Date(end).toISOString();
  }

  return { ok: true, reason: '', startTime: new Date(start).toISOString(), endTime };
}

/**
 * Reject listings that sit outside every area being searched.
 *
 * Only listings that arrive with coordinates can be judged here; the ones
 * without are checked later, when geocoding places them. The 1.5x slack keeps
 * a venue just over the line from being dropped on a radius the user picked
 * for search, not for relevance.
 */
export function validateLocation(ev: RawEvent, locations: Location[]): { ok: boolean; reason: string } {
  if (ev.lat == null || ev.lng == null) return { ok: true, reason: '' };
  const near = locations.some((loc) => haversineKm(loc.lat, loc.lng, ev.lat!, ev.lng!) <= loc.radiusKm * 1.5);
  if (near) return { ok: true, reason: '' };
  const nearest = Math.min(...locations.map((loc) => haversineKm(loc.lat, loc.lng, ev.lat!, ev.lng!)));
  return { ok: false, reason: `${Math.round(nearest)} km outside every area` };
}

/** Placeholders that sources put in the address field instead of leaving it empty. */
const NOT_AN_ADDRESS = /^(tba|tbc|tbd|n\/?a|none|null|undefined|online|virtual|to be (announced|confirmed)|see (website|link|below)|various( locations)?)$/i;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Restore a name that arrived shouting.
 *
 * "169 COLLEGE ROAD" is how one source writes every address, and it reads as
 * a shout next to every other line on the card. Only strings with no lowercase
 * letter at all are touched, so a name that deliberately mixes case keeps
 * whatever it chose. Words of three letters or fewer stay upper — RSL, NSW,
 * BMW and GP are acronyms, not shouting — and a word glued to a digit
 * ("FIT4ALL") is left alone, since that is a brand rather than a sentence.
 */
export function titleCaseShouting(text: string): string {
  if (!text || /[a-z]/.test(text)) return text;
  return text.replace(/[\p{L}][\p{L}'’]*/gu, (word) =>
    word.length <= 3 ? word : word[0] + word.slice(1).toLowerCase()
  );
}

/**
 * Tidy an address into its distinct components.
 *
 * Half the stored addresses were self-contradicting tails: JSON-LD gives a
 * streetAddress that is already complete ("114 Rankin St, Bathurst NSW 2795,
 * Australia") and separate locality and region fields, and appending those
 * produced "…, Australia, Bathurst, NS" — the town twice and the region
 * truncated. That is what reaches the geocoder and the place headings, so it
 * is worth straightening before it is stored.
 *
 * Two things are dropped: a component repeated verbatim, and a component
 * already spelled out inside an earlier one. The second only applies when the
 * earlier component is address-shaped — it carries a number or a region — so
 * "Bathurst Memorial Entertainment Centre, Bathurst" keeps its suburb rather
 * than having it swallowed by the venue's name.
 *
 * `defaultRegion` is the region the user's other addresses name, and is the
 * only thing that makes the truncation repair safe outside one country. See
 * regions.ts.
 */
export function cleanAddress(address: string, defaultRegion = ''): string {
  const parts = address
    .split(',')
    .map((p) => titleCaseShouting(p.trim().replace(/\s+/g, ' ')))
    .filter(Boolean)
    .map((p) => expandRegion(p, defaultRegion))
    .filter((p) => !NOT_AN_ADDRESS.test(p));

  const kept: string[] = [];
  for (const part of parts) {
    if (kept.some((k) => k.toLowerCase() === part.toLowerCase())) continue;
    const spelledOutAlready = kept.some(
      (k) =>
        (/\d/.test(k) || k !== stripRegionAndPostcode(k)) &&
        new RegExp(`\\b${escapeRe(part)}\\b`, 'i').test(k)
    );
    if (spelledOutAlready) continue;
    kept.push(part);
  }

  // The country ends a postal address, so anything after it is the search
  // area the source stapled on. "Neville, NSW, Australia, Bathurst" is an
  // event in Neville, and keeping the tail would file it under the wrong town
  // — the one case here where the components genuinely contradict rather than
  // repeat, so it cannot be settled by de-duplication.
  const country = kept.findIndex((k) => isCountry(k));
  return (country === -1 ? kept : kept.slice(0, country + 1)).join(', ');
}

/**
 * What to store for an address: the tidied form, or '' when the source only
 * ever had a placeholder. An empty address is not a reason to drop the event —
 * a venue name alone still geocodes — so this repairs rather than rejects.
 */
export function validateAddress(address: string | undefined, defaultRegion = ''): string {
  const cleaned = cleanAddress(address ?? '', defaultRegion);
  return NOT_AN_ADDRESS.test(cleaned) ? '' : cleaned;
}

/**
 * Named entities worth knowing without pulling in a parser. Event blurbs are
 * punctuation-heavy — curly quotes, en dashes, ellipses — and everything else
 * a feed emits is numeric.
 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', deg: '°', trade: '™',
  copy: '©', reg: '®', eacute: 'é', middot: '·', bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Turn a scraped description into plain text.
 *
 * Feeds hand over whatever their CMS stored: WordPress ships block comments
 * and <p> wrappers, others ship a "read more" anchor mid-sentence, and several
 * carry the two characters backslash-n where a line break belongs — all of
 * which the detail panel showed verbatim, tags and all.
 *
 * Entities are decoded before tags are stripped, so a description that arrived
 * double-escaped ("&lt;p&gt;") loses its markup too rather than displaying it
 * as text. Paragraph and break tags become blank lines; everything else simply
 * goes, since the panel renders plain text.
 */
export function cleanDescription(description: string | undefined): string {
  if (!description) return '';
  return decodeEntities(description)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    // Not newlines but the two literal characters, straight out of a JSON
    // field that was embedded in another JSON field somewhere upstream.
    .replace(/(?:\\r)?\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The date a merged group should show.
 *
 * Members disagree: a cruise listed on the 22nd by four sources had a fifth
 * calling it the 21st, and taking the earliest member — which is what sorting
 * by start time and reading member zero amounts to — let that one outlier
 * rename the event's day. The calendar date most members agree on wins; ties
 * break towards the earlier date, and within the winning date the earliest
 * start is used, since that is the one a photographer needs to be there for.
 */
export function consensusStart(starts: string[]): string {
  if (starts.length === 0) return '';
  const byDate = new Map<string, string[]>();
  for (const s of starts) {
    const date = s.slice(0, 10);
    const list = byDate.get(date);
    if (list) list.push(s);
    else byDate.set(date, [s]);
  }
  let best = '';
  let bestCount = 0;
  for (const [date, list] of byDate) {
    if (list.length > bestCount || (list.length === bestCount && date < best)) {
      best = date;
      bestCount = list.length;
    }
  }
  return byDate.get(best)!.slice().sort()[0];
}
