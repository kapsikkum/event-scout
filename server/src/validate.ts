import { localDay } from './day.js';
import { haversineKm, inArea } from './shared/geo.js';
import { FUTURE_HORIZON_MS, MAX_DURATION_MS, PAST_GRACE_MS } from './shared/when.js';
import { cleanDescription, NOT_AN_ADDRESS, titleCaseShouting } from './shared/text.js';

export { cleanDescription, titleCaseShouting };
import { Location, RawEvent } from './sources/types.js';
import { expandRegion, isCountry, stripRegionAndPostcode } from './regions.js';

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
  if (start > now + FUTURE_HORIZON_MS) {
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
 * without are checked later, when geocoding places them. See AREA_SLACK.
 */
export function validateLocation(ev: RawEvent, locations: Location[]): { ok: boolean; reason: string } {
  if (ev.lat == null || ev.lng == null) return { ok: true, reason: '' };
  const near = locations.some((loc) => inArea(ev.lat!, ev.lng!, loc));
  if (near) return { ok: true, reason: '' };
  const nearest = Math.min(...locations.map((loc) => haversineKm(loc.lat, loc.lng, ev.lat!, ev.lng!)));
  return { ok: false, reason: `${Math.round(nearest)} km outside every area` };
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * The date a merged group should show.
 *
 * Members disagree: a cruise listed on the 22nd by four sources had a fifth
 * calling it the 21st, and taking the earliest member — which is what sorting
 * by start time and reading member zero amounts to — let that one outlier
 * rename the event's day. The local calendar date most members agree on wins,
 * and ties break towards the earlier date.
 *
 * Within the winning date a stated time beats a bare date, and then the
 * earliest start is used, since that is the one a photographer needs to be
 * there for. The first rule matters because a bare date is stored as local
 * midnight: left to "earliest wins" it would beat every real time on its day,
 * and a group would show "12:00 am" although one of its sources knew better.
 *
 * `dateOnly` runs parallel to `starts`, and may be left out when none are.
 */
export function consensusStart(starts: string[], dateOnly: boolean[] = []): string {
  if (starts.length === 0) return '';
  const byDate = new Map<string, { start: string; bare: boolean }[]>();
  starts.forEach((start, i) => {
    // The local day, not the UTC one: see day.ts.
    const date = localDay(start);
    const entry = { start, bare: dateOnly[i] === true };
    const list = byDate.get(date);
    if (list) list.push(entry);
    else byDate.set(date, [entry]);
  });
  let best = '';
  let bestCount = 0;
  for (const [date, list] of byDate) {
    if (list.length > bestCount || (list.length === bestCount && date < best)) {
      best = date;
      bestCount = list.length;
    }
  }
  const winners = byDate.get(best)!;
  const timed = winners.filter((w) => !w.bare);
  return (timed.length > 0 ? timed : winners).map((w) => w.start).sort()[0];
}

/**
 * A merged group's start, and whether it has a clock time at all.
 *
 * A time typed in edit mode is always a real time. Otherwise the consensus
 * above picks the start, preferring a stated one, so the group is date-only
 * only when nothing on its winning start gave a time — one source that knew
 * the hour is enough.
 */
export function groupStart(
  members: { start_time: string; date_only: number }[],
  edited: string
): { startTime: string; dateOnly: boolean } {
  if (edited) return { startTime: edited, dateOnly: false };
  const startTime = consensusStart(
    members.map((m) => m.start_time),
    members.map((m) => m.date_only === 1)
  );
  const on = members.filter((m) => m.start_time === startTime);
  return { startTime, dateOnly: on.length > 0 && on.every((m) => m.date_only === 1) };
}

/**
 * Whether an event has been and gone.
 *
 * An event that carries an end time is over when that end passes. One that
 * carries none is over at the end of the day it started: a listing that says
 * "Sunday 10:30am" and nothing more is worth showing for the rest of Sunday
 * and no longer. Local midnight, not a fixed number of hours, because the
 * complaint this answers is about yesterday's events rather than about a
 * particular number of hours having elapsed.
 */
export function isOver(startTime: string, endTime: string | null, now: Date = new Date()): boolean {
  return endOf(startTime, endTime) <= now.getTime();
}

/**
 * When an event stops being worth showing, as a timestamp: its end, or the
 * close of the day it starts on when it has none. What isOver compares, and
 * what a question like "what's on today" has to ask about — an all-day event
 * starts at midnight, so asking only about starts loses it at 1am.
 */
export function endOf(startTime: string, endTime: string | null): number {
  const end = endTime ? Date.parse(endTime) : NaN;
  // Strictly after, so an end equal to now reads as still running for isOver's
  // `end < now` as it always has.
  if (Number.isFinite(end)) return end + 1;
  const start = Date.parse(startTime);
  if (!Number.isFinite(start)) return Infinity;
  const day = new Date(start);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
}
