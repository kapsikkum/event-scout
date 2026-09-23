import crypto from 'node:crypto';
import { db, getKv, getSettings, setKv } from './db.js';
import { assignDedupeGroups, DedupeInput } from './dedupe.js';
import { AREA_SLACK, inArea } from './shared/geo.js';
import { countriesOfAreas, regionsOfAreas } from './places.js';
import { anchorQueries, Hit, isPlace, pickAnchor, pickHit, placeQueries, statedOf, textAnchorQuery } from './locate.js';
import { MAX_DURATION_MS } from './shared/when.js';
import { photoScore } from './photoScore.js';
import { crawlerSource } from './sources/crawler.js';
import { eventbrite } from './sources/eventbrite.js';
import { facebook } from './sources/facebook.js';
import { icalSource } from './sources/ical.js';
import { midnightspec } from './sources/midnightspec.js';
import { seatgeek } from './sources/seatgeek.js';
import { ticketmaster } from './sources/ticketmaster.js';
import { websearch } from './sources/websearch.js';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, SourceStatus } from './sources/types.js';
import { geocode, isGeocodeCached } from './geocode.js';
import { classifyEvent } from './sources/topics.js';
import { cleanAddress, cleanDescription, validateAddress, validateDates, validateLocation } from './validate.js';
import { localitiesFrom, unifyVenueNames } from './venues.js';
import { defaultRegionFrom, localityOf, regionOf } from './regions.js';

export const ADAPTERS: EventSourceAdapter[] = [
  ticketmaster, seatgeek, eventbrite, facebook, websearch, icalSource, midnightspec, crawlerSource,
];

let refreshing = false;
let refreshStartedAt = 0;
let refreshRun = 0;

/**
 * How long a refresh may run before a new one is allowed to start anyway.
 *
 * A source that hangs — the Facebook one drives a real browser — leaves the
 * in-progress flag set for the life of the process, and every hourly attempt
 * after it fails with "a refresh is already running". That is how this
 * database went ten days without being refreshed while the server sat there
 * apparently healthy. A refresh that has overrun this is not coming back.
 */
const REFRESH_WATCHDOG_MS = 30 * 60 * 1000;

/** Search queries one refresh may spend in total, across every area. */
const TOTAL_QUERY_BUDGET = 18;

/** Breathing room between areas, for the same reason as the per-query spacing. */
const AREA_SPACING_MS = 2500;

export function isRefreshing(): boolean {
  return refreshing && Date.now() - refreshStartedAt < REFRESH_WATCHDOG_MS;
}

const upsertStmt = () =>
  db.prepare(`
    INSERT INTO events (source, source_id, title, description, start_time, end_time, venue_name, address,
                        lat, lng, url, image_url, category, price_text, is_online, photo_score, last_seen_at,
                        date_only, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      venue_name = excluded.venue_name,
      address = excluded.address,
      -- A position looked up for this place is kept while the address is the
      -- same (or, with none, the venue name, which repairVenueNames respells): overwriting it with the source's empty one lost it every refresh,
      -- and geocode_tried stopped it being looked up again. A new venue or
      -- address is looked up afresh.
      lat = CASE WHEN excluded.lat IS NOT NULL THEN excluded.lat
                 WHEN excluded.address = events.address AND (excluded.address != '' OR excluded.venue_name = events.venue_name) THEN events.lat END,
      lng = CASE WHEN excluded.lat IS NOT NULL THEN excluded.lng
                 WHEN excluded.address = events.address AND (excluded.address != '' OR excluded.venue_name = events.venue_name) THEN events.lng END,
      geocode_tried = CASE WHEN excluded.address = events.address AND (excluded.address != '' OR excluded.venue_name = events.venue_name)
                           THEN events.geocode_tried ELSE 0 END,
      -- A page that moved on to its next date is live again, and new: it was
      -- archived under the old one. Still past, it is archived again at once.
      archived = CASE WHEN excluded.start_time > events.start_time THEN 0 ELSE events.archived END,
      first_seen_at = CASE WHEN events.archived = 1 AND excluded.start_time > events.start_time
                           THEN excluded.first_seen_at ELSE events.first_seen_at END,
      url = excluded.url,
      image_url = excluded.image_url,
      category = excluded.category,
      price_text = excluded.price_text,
      is_online = excluded.is_online,
      date_only = excluded.date_only,
      photo_score = excluded.photo_score,
      last_seen_at = excluded.last_seen_at
  `);

/**
 * What the current refresh is doing, for the UI to watch.
 *
 * A refresh is one long request — six sources across up to three areas, each
 * of them rate-limited — so from the outside it was a spinning icon and no
 * way to tell a slow source from a stuck one, or to see anything it had
 * already found. This is held in memory rather than the database: it is only
 * meaningful while the run is happening, and a run does not outlive the
 * process.
 */
interface Progress {
  startedAt: string | null;
  /** Newest last. Capped, because websearch alone can log a line per query. */
  lines: string[];
  /** Events kept so far this run, across every source. */
  found: number;
  /** What each source is doing right now, for the per-source display. */
  active: Record<string, string>;
}

const progress: Progress = { startedAt: null, lines: [], found: 0, active: {} };

function note(line: string): void {
  progress.lines.push(line);
  if (progress.lines.length > 120) progress.lines.shift();
}

export function getProgress(): Progress {
  return {
    startedAt: progress.startedAt,
    lines: [...progress.lines],
    found: progress.found,
    active: { ...progress.active },
  };
}

function setStatus(name: string, state: SourceStatus['state'], message: string, count: number | null): void {
  db.prepare(`
    INSERT INTO source_status (name, state, message, last_fetch, count)
    VALUES (?, ?, ?, ?, COALESCE(?, 0))
    ON CONFLICT(name) DO UPDATE SET
      state = excluded.state,
      message = excluded.message,
      last_fetch = excluded.last_fetch,
      count = COALESCE(?, source_status.count)
  `).run(name, state, message, new Date().toISOString(), count, count);
}

/**
 * Every place to look, home city first.
 *
 * Extra areas may be given as a bare name; those are geocoded here rather than
 * making the user find coordinates. Nominatim results are cached, so this costs
 * one lookup the first time an area is added and nothing after that. An area
 * that cannot be resolved is dropped with a warning rather than failing the
 * whole refresh.
 */
export async function eventLocations(settings: {
  lat: number | null; lng: number | null; radiusKm: number; city: string;
  eventAreas?: { name: string; lat?: number; lng?: number; radiusKm?: number }[];
}): Promise<Location[]> {
  const locations: Location[] = [];
  if (settings.lat != null && settings.lng != null) {
    locations.push({
      lat: settings.lat, lng: settings.lng,
      radiusKm: settings.radiusKm, city: settings.city,
    });
  }

  for (const area of settings.eventAreas ?? []) {
    const name = (area.name ?? '').trim();
    if (!name) continue;
    let { lat, lng } = area;
    if (lat == null || lng == null) {
      try {
        const [hit] = await geocode(name);
        if (!hit) {
          console.warn(`Event area "${name}" could not be geocoded; skipping`);
          continue;
        }
        lat = hit.lat;
        lng = hit.lng;
      } catch (err) {
        console.warn(`Event area "${name}" lookup failed: ${(err as Error).message}`);
        continue;
      }
    }
    locations.push({ lat, lng, radiusKm: area.radiusKm ?? settings.radiusKm, city: name });
  }

  // Spread one refresh's search budget over the areas rather than spending it
  // per area. Three areas at full budget meant three dozen queries back to back,
  // after which the engines returned empty pages instead of errors — so the
  // later areas silently found nothing and the refresh still reported success.
  if (locations.length > 1) {
    const each = Math.max(4, Math.round(TOTAL_QUERY_BUDGET / locations.length));
    for (const loc of locations) loc.queryBudget = each;
  }
  return locations;
}

export async function refreshAll(): Promise<SourceStatus[]> {
  if (isRefreshing()) throw new Error('A refresh is already running');
  if (refreshing) console.warn('Previous refresh never finished; starting a new one');
  refreshing = true;
  refreshStartedAt = Date.now();
  const run = ++refreshRun;
  try {
    const settings = getSettings();
    if (settings.lat == null || settings.lng == null) {
      throw new Error('Set a location in Settings before refreshing');
    }
    const locations = await eventLocations(settings);
    const areaRegions = regionsOfAreas(locations.map((l) => l.city));
    const now = new Date().toISOString();

    progress.startedAt = now;
    progress.lines = [];
    progress.found = 0;
    progress.active = {};
    const where = locations.map((l) => l.city).filter(Boolean).join(', ');
    note(`Looking in ${where || 'the configured area'}`);

    await Promise.allSettled(
      ADAPTERS.map(async (adapter) => {
        if (settings.enabledSources[adapter.name] === false) {
          setStatus(adapter.name, 'disabled', 'Disabled in Settings', null);
          return;
        }
        // Each area is fetched separately; the unique(source, source_id) index
        // collapses anything two overlapping areas both return.
        let total = 0;
        let missing: MissingConfigError | null = null;
        const failures: string[] = [];
        const rejected: string[] = [];
        let far = 0;

        for (const [i, loc] of locations.entries()) {
          try {
            if (i > 0) await new Promise((r) => setTimeout(r, AREA_SPACING_MS));
            progress.active[adapter.name] = locations.length > 1 ? `searching ${loc.city}` : 'searching';
            const raw = await adapter.fetchEvents(loc, settings);
            // Sources are not trustworthy about dates: recurring-event pages
            // keep last year's startDate in their markup, and a stale one
            // sails through as a real listing unless it is checked here.
            const kept: RawEvent[] = [];
            let areaRejected = 0;
            let areaFar = 0;
            for (const ev of raw) {
              const dates = validateDates(ev);
              if (!dates.ok) {
                rejected.push(`${ev.title}: ${dates.reason}`);
                areaRejected++;
                continue;
              }
              const where = validateLocation(ev, [loc], areaRegions);
              if (!where.ok) {
                areaFar++;
                continue;
              }
              kept.push({ ...ev, startTime: dates.startTime, endTime: dates.endTime ?? undefined });
            }
            const stmt = upsertStmt();
            for (const ev of kept) insertRaw(stmt, adapter.name, ev, now, localRegion());
            total += kept.length;
            progress.found += kept.length;
            const area = locations.length > 1 ? ` in ${loc.city}` : '';
            far += areaFar;
            const dropped =
              (areaRejected ? `, ${areaRejected} rejected on date` : '') + (areaFar ? `, ${areaFar} outside the area` : '');
            note(`${adapter.label}: ${kept.length} event${kept.length === 1 ? '' : 's'}${area}${dropped}`);
          } catch (err) {
            // Missing config is about the source, not the area, so stop early
            // rather than repeating the same complaint once per area.
            if (err instanceof MissingConfigError) {
              missing = err;
              break;
            }
            failures.push(`${loc.city}: ${(err as Error).message}`);
          }
        }

        delete progress.active[adapter.name];

        if (missing) {
          note(`${adapter.label}: not configured`);
          setStatus(adapter.name, 'missing_config', missing.message, null);
        } else if (failures.length === locations.length && locations.length > 0) {
          // The same feed failing in every area is one fault, not N.
          const reasons = [...new Set(failures.map((f) => f.slice(f.indexOf(': ') + 2)))];
          note(`${adapter.label}: failed — ${reasons[0]}`);
          setStatus(
            adapter.name, 'error',
            reasons.length === 1 ? reasons[0] : failures.join('; '), null
          );
        } else {
          const where = locations.length > 1 ? ` across ${locations.length} areas` : '';
          const partly = failures.length ? ` (${failures.length} area failed)` : '';
          // Worth saying out loud: a source that suddenly has everything
          // rejected is a parser that has broken, not a quiet week.
          const dropped =
            (rejected.length ? `, ${rejected.length} rejected on date` : '') + (far ? `, ${far} outside every area` : '');
          setStatus(adapter.name, 'ok', `Fetched ${total} events${where}${dropped}${partly}`, total);
          if (rejected.length) console.warn(`[${adapter.name}] rejected: ${rejected.slice(0, 10).join('; ')}`);
        }
      })
    );

    note('Tidying dates, addresses and venue names');
    repairImplausibleDates();
    repairAddresses();
    repairVenueNames();
    const { archived } = archivePastEvents();
    if (archived > 0) note(`Archived ${archived} that have been and gone`);
    reclassifyAll();

    // Worth its own line: this is the slow tail of a refresh. Nominatim asks
    // for a second between lookups, so sixty venues is a minute on its own,
    // and without a note here the run looks hung after the last source.
    forgetInventedPositions();
    note('Placing venues on the map');
    const placed = await geocodeMissing(locations);
    if (placed > 0) note(`Placed ${placed} venue${placed === 1 ? '' : 's'}`);

    note('Matching duplicate listings');
    recomputeDedupeGroups();
    setKv('lastRefresh', now);
    note(`Done — ${progress.found} event${progress.found === 1 ? '' : 's'} kept`);
    return getStatuses();
  } finally {
    // Only if nothing has started since: an abandoned run that finally comes
    // back must not clear the flag out from under the one that replaced it.
    if (run === refreshRun) refreshing = false;
  }
}

/**
 * Forget the positions the old geocoder invented, once.
 *
 * Until locate.ts, a listing whose town was not one of the areas was looked up
 * with an area's name stapled on, and "Darwin, Bathurst" is a real street in
 * Bathurst. Every position this app looked up that way is suspect, so they go
 * and are looked up again under the rules that replaced it. A position a
 * source supplied is untouched: those never went through the geocoder, which
 * is what geocode_tried marks.
 */
function forgetInventedPositions(): void {
  const flag = 'migrate:anchored-geocoding';
  if (getKv(flag)) return;
  const cleared = db
    .prepare('UPDATE events SET lat = NULL, lng = NULL, geocode_tried = 0 WHERE lat IS NOT NULL AND geocode_tried = 1')
    .run().changes;
  setKv(flag, new Date().toISOString());
  if (cleared) console.log(`[refresh] re-placing ${cleared} events looked up under the old rules`);
}

/** Lookups per refresh. Nominatim asks for one request a second. */
const GEOCODE_BUDGET = 120;
const GEOCODE_SPACING_MS = 1100;

/**
 * Put coordinates on events that arrived without any.
 *
 * Most sources give a venue name and no position, which left 103 of 138 events
 * invisible on the map — they were being fetched and stored perfectly well and
 * simply had nowhere to be drawn. The venue name is enough to place them.
 *
 * The town a listing names is looked up first and anchors the rest; see
 * locate.ts for why that matters more than anything else here. Lookups are
 * cached, so a town costs one request ever however many listings name it.
 */
async function geocodeMissing(locations: Location[]): Promise<number> {
  if (locations.length === 0) return 0;
  const countries = countriesOfAreas(locations.map((l) => l.city));
  const rows = db
    .prepare(
      // A venue the model or the flyer read counts, where the listing gave none.
      `SELECT id,
              COALESCE(NULLIF(venue_name, ''), NULLIF(vision_venue_name, ''), llm_venue_name) AS venue_name,
              COALESCE(NULLIF(address, ''), NULLIF(vision_address, ''), llm_address) AS address
         FROM events
        WHERE lat IS NULL AND archived = 0 AND geocode_tried = 0
          AND (venue_name != '' OR address != '' OR vision_venue_name != '' OR vision_address != ''
               OR llm_venue_name != '' OR llm_address != '')
        ORDER BY start_time`
    )
    .all() as unknown as { id: number; venue_name: string; address: string }[];

  // The budget is for requests to Nominatim. A query already looked up costs
  // nothing, so a backlog of known towns and venues is never what holds this up.
  let placed = 0;
  const spend = { asked: 0, budget: GEOCODE_BUDGET };
  for (const row of rows) {
    if (await placeRow(row, locations, spend, countries)) placed++;
  }
  return placed;
}

/** Ask the geocoder, paying the rate limit only for a question not asked before. */
async function ask(query: string, spend: { asked: number; budget: number }): Promise<Hit[] | null> {
  if (isGeocodeCached(query)) return geocode(query);
  if (spend.asked >= spend.budget) return null;
  spend.asked++;
  await new Promise((r) => setTimeout(r, GEOCODE_SPACING_MS));
  return geocode(query);
}

/** One row of geocodeMissing: true when it was placed. */
async function placeRow(
  row: { id: number; venue_name: string; address: string },
  locations: Location[],
  spend: { asked: number; budget: number },
  countries: string[] = []
): Promise<boolean> {
  const markTried = db.prepare('UPDATE events SET geocode_tried = 1 WHERE id = ?');
  const stated = statedOf(row.venue_name, row.address);
  let errored = false;

  // The town first. Its position is the anchor every other answer is measured
  // against, and for a listing from far away it is the answer: a Darwin event
  // belongs at Darwin, where the area rule can see it, not at the Darwin Drive
  // a search for "Darwin, Bathurst" turns up.
  let anchor: Hit | null = null;
  const fits = (h: Hit): boolean => !stated.region || !regionOf(h.displayName) || regionOf(h.displayName) === stated.region;
  for (const town of anchorQueries(stated)) {
    try {
      const hits = await ask(town, spend);
      if (hits === null) return false;
      anchor = pickAnchor(hits, { region: stated.region, areas: locations, slack: AREA_SLACK, countries });
      if (anchor) break;
    } catch {
      errored = true;
    }
  }
  // A venue field that is really a shout — "MXGP DARWIN AUSTRALIA" — names its
  // town and nothing else useful. Only an answer that is a town is taken.
  const text = anchor ? '' : textAnchorQuery(row.venue_name, row.address, stated);
  if (text) {
    try {
      const hits = await ask(text, spend);
      if (hits === null) return false;
      const found = pickAnchor(hits, { region: stated.region, areas: locations, slack: AREA_SLACK, countries });
      anchor = found && isPlace(found) ? found : null;
    } catch {
      errored = true;
    }
  }

  const queries = placeQueries(row.venue_name, row.address, stated, locations.map((l) => ({ name: l.city })));
  for (const query of queries) {
    try {
      const hits = await ask(query, spend);
      if (hits === null) return false;
      const hit = pickHit(hits, { region: stated.region, anchor, areas: locations, slack: AREA_SLACK });
      if (hit) {
        db.prepare('UPDATE events SET lat = ?, lng = ?, geocode_tried = 1 WHERE id = ?').run(hit.lat, hit.lng, row.id);
        return true;
      }
    } catch {
      errored = true;
    }
  }

  // Nothing exact, but the town is known: the town's own position is a true
  // answer to "where is this", and the only one that lets an event outside
  // every area be recognised as outside every area.
  if (anchor) {
    db.prepare('UPDATE events SET lat = ?, lng = ?, geocode_tried = 1 WHERE id = ?').run(anchor.lat, anchor.lng, row.id);
    return true;
  }
  // Genuinely unplaceable rather than a transient failure, so stop asking.
  if (!errored) markTried.run(row.id);
  return false;
}

/** An event typed or checked by a person, from "Add from a link". */
export interface ManualEvent {
  url: string;
  title: string;
  description: string;
  startTime: string;
  dateOnly: boolean;
  endTime: string;
  venueName: string;
  address: string;
  imageUrl: string;
  priceText: string;
  /** '' to let the classifier decide, as it does for every other listing. */
  category: string;
}

/**
 * Store an event added by hand, and say which group it landed in.
 *
 * Through the same insert every source uses, as source "manual", so it is
 * tidied, scored, deduplicated against the same event found elsewhere, and
 * archived when it is over exactly like the rest. The id is the link, the
 * title and the start, so saving the same thing twice updates it. A category
 * chosen by hand goes where the classifier's nightly re-run cannot reach it.
 * Placed on the map straight away when it has somewhere to place, rather than
 * at the next refresh, so the card has its town the moment it appears.
 */
export async function addManualEvent(input: ManualEvent): Promise<string> {
  const now = new Date().toISOString();
  const sourceId =
    'manual:' +
    crypto.createHash('sha1').update(`${input.url}|${input.title}|${input.startTime}`).digest('hex').slice(0, 16);
  const raw: RawEvent = {
    sourceId,
    title: input.title,
    description: input.description,
    startTime: input.startTime,
    endTime: input.endTime || undefined,
    venueName: input.venueName,
    address: input.address,
    url: input.url,
    imageUrl: input.imageUrl,
    priceText: input.priceText,
    dateOnly: input.dateOnly,
  };
  insertRaw(upsertStmt(), 'manual', raw, now, localRegion());
  const row = db
    .prepare("SELECT id, venue_name, address FROM events WHERE source = 'manual' AND source_id = ?")
    .get(sourceId) as unknown as { id: number; venue_name: string; address: string };
  db.prepare('UPDATE events SET edit_category = ?, archived = 0, geocode_tried = 0 WHERE id = ?')
    .run(input.category.trim(), row.id);

  if (row.venue_name || row.address) {
    try {
      const here = await eventLocations(getSettings());
      await placeRow(row, here, { asked: 0, budget: GEOCODE_BUDGET }, countriesOfAreas(here.map((l) => l.city)));
    } catch {
      // The next refresh tries again; saving must not fail on a map lookup.
    }
  }
  recomputeDedupeGroups();
  const group = db.prepare('SELECT manual_group, dedupe_group FROM events WHERE id = ?').get(row.id) as unknown as {
    manual_group: string;
    dedupe_group: string;
  };
  return group.manual_group || group.dedupe_group || `solo-${row.id}`;
}

/** Attempts per event, so one stubborn venue cannot eat the whole budget. */
const GEOCODE_ATTEMPTS = 4;

/**
 * Drop end times that cannot be true, on rows already stored.
 *
 * This is the cleanup half of validateDates: rows ingested before that check
 * existed still carry ends like "start 2025-08-22, end 2026-10-23", and
 * archivePastEvents reads COALESCE(end_time, start_time) — so a year-old
 * listing with a far-future end never ages out and sits at the top of the
 * list forever. Nulling the end lets the start decide, which it should.
 */
export function repairImplausibleDates(): number {
  const changed = db
    .prepare(
      `UPDATE events SET end_time = NULL
       WHERE end_time IS NOT NULL
         AND (end_time <= start_time
              OR julianday(end_time) - julianday(start_time) > ${MAX_DURATION_MS / 86400_000})`
    )
    .run().changes;
  return Number(changed);
}

/**
 * Tidy the addresses on rows already stored.
 *
 * Same job as validateAddress does at ingest, for the 174-odd rows that
 * predate it. Worth running every refresh rather than once: the address feeds
 * the geocoder and the place headings, and a row whose address improves may
 * geocode on a later pass where it failed before.
 */
export function repairAddresses(): number {
  const rows = db
    .prepare("SELECT id, venue_name, address, description FROM events WHERE address != '' OR venue_name != '' OR description != ''")
    .all() as unknown as { id: number; venue_name: string; address: string; description: string }[];
  // Whatever region the addresses agree on is the one a truncated region
  // field is short for; see regions.ts.
  const region = defaultRegionFrom(rows.map((r) => r.address).filter(Boolean));
  const update = db.prepare('UPDATE events SET venue_name = ?, address = ?, description = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    const venue = cleanAddress(row.venue_name ?? '', region);
    const address = validateAddress(row.address, region);
    const description = cleanDescription(row.description).slice(0, 4000);
    if (venue !== row.venue_name || address !== row.address || description !== row.description) {
      update.run(venue, address, description, row.id);
      changed++;
    }
  }
  return changed;
}

/**
 * Collapse the spellings of one venue down to a single name.
 *
 * Runs over the whole table each refresh rather than at ingest, because it is
 * a decision that needs every spelling in front of it: which name wins depends
 * on how often each is used, and a name arriving today can be the one that
 * links two clusters that looked separate yesterday.
 */
export function repairVenueNames(): number {
  const rows = db
    .prepare("SELECT venue_name AS name, COUNT(*) AS count FROM events WHERE venue_name != '' GROUP BY venue_name")
    .all() as unknown as { name: string; count: number }[];
  const addresses = (
    db.prepare("SELECT address FROM events WHERE address != ''").all() as unknown as { address: string }[]
  ).map((r) => r.address);

  const settings = getSettings();
  const areaNames = [settings.city, ...settings.eventAreas.map((a) => a.name)].filter(Boolean);
  const canonical = unifyVenueNames(rows, localitiesFrom(areaNames, addresses));
  if (canonical.size === 0) return 0;

  const update = db.prepare('UPDATE events SET venue_name = ? WHERE venue_name = ?');
  let changed = 0;
  for (const [from, to] of canonical) changed += Number(update.run(to, from).changes);
  return changed;
}

/** Days of archived history to keep. Starred events are never purged. */
const ARCHIVE_RETENTION_DAYS = 730;

/**
 * Move events that have been and gone into the archive, rather than deleting
 * them. Very old archived rows are eventually purged so the database stays
 * bounded, but anything starred is kept indefinitely.
 *
 * The two halves of the condition are isOver() written in SQL: an event with
 * an end time goes when that end passes, one without goes at the end of the
 * day it started on. It used to be a flat "finished more than 24 hours ago"
 * against COALESCE(end_time, start_time), which kept yesterday morning's
 * events on the page until this morning.
 */
export function archivePastEvents(): { archived: number; purged: number } {
  const now = Date.now();
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const archived = db
    .prepare(
      `UPDATE events SET archived = 1, archived_at = ?
       WHERE archived = 0
         AND ((end_time IS NOT NULL AND end_time < ?)
              OR (end_time IS NULL AND start_time < ?))`
    )
    .run(new Date(now).toISOString(), new Date(now).toISOString(), startOfToday).changes;

  const purgeBefore = new Date(now - ARCHIVE_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const purged = db
    .prepare(
      `DELETE FROM events
       WHERE archived = 1 AND starred = 0 AND COALESCE(end_time, start_time) < ?`
    )
    .run(purgeBefore).changes;

  return { archived: Number(archived), purged: Number(purged) };
}

/**
 * The region the stored addresses agree on, cached for the length of a
 * refresh. Reading it per row would mean a full table scan per event.
 */
let cachedRegion: { at: number; value: string } | null = null;
function localRegion(): string {
  if (cachedRegion && Date.now() - cachedRegion.at < 60_000) return cachedRegion.value;
  const rows = db.prepare("SELECT address FROM events WHERE address != ''").all() as unknown as {
    address: string;
  }[];
  cachedRegion = { at: Date.now(), value: defaultRegionFrom(rows.map((r) => r.address)) };
  return cachedRegion.value;
}

function insertRaw(
  stmt: ReturnType<typeof upsertStmt>, source: string, ev: RawEvent, now: string, region: string
): void {
  stmt.run(
    source,
    ev.sourceId,
    ev.title.slice(0, 300),
    cleanDescription(ev.description).slice(0, 4000),
    new Date(ev.startTime).toISOString(),
    ev.endTime ? new Date(ev.endTime).toISOString() : null,
    cleanAddress(ev.venueName ?? '', region),
    validateAddress(ev.address, region),
    ev.lat ?? null,
    ev.lng ?? null,
    ev.url ?? '',
    ev.imageUrl ?? '',
    // Sources are hopeless at this: Facebook labels everything "Facebook" and
    // most of the rest say "Event", which is what all of them are.
    classifyEvent(ev.title, ev.description ?? '', ev.category ?? '', ev.venueName ?? ''),
    ev.priceText ?? '',
    ev.isOnline ? 1 : 0,
    photoScore(ev),
    now,
    ev.dateOnly ? 1 : 0,
    // Only ever used by the INSERT: the conflict branch leaves it alone.
    now
  );
}

/**
 * Re-run the classifier over everything already stored.
 *
 * Runs on every refresh rather than once at import: the classifier's keywords
 * get better over time, and rows filed under an older version would otherwise
 * keep their stale category forever. It is a pure string match over a few
 * hundred rows, so the cost is nil.
 */
export function reclassifyAll(): number {
  const rows = db
    .prepare('SELECT id, title, description, category, venue_name FROM events')
    .all() as unknown as { id: number; title: string; description: string; category: string; venue_name: string | null }[];
  const update = db.prepare('UPDATE events SET category = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    // The stored category may itself be a previous verdict, so classify from
    // the text alone and let the source's original value stay out of it.
    const next = classifyEvent(row.title, row.description ?? '', '', row.venue_name ?? '');
    if (next !== row.category) {
      update.run(next, row.id);
      changed++;
    }
  }
  return changed;
}

function recomputeDedupeGroups(): void {
  const rows = db
    // The model's name where it gave one: a caption for a title matches nothing.
    .prepare("SELECT id, COALESCE(NULLIF(llm_title, ''), title) AS title, start_time AS startTime, end_time AS endTime, lat, lng, venue_name AS venueName, date_only AS dateOnly FROM events ORDER BY start_time ASC, id ASC")
    .all() as unknown as DedupeInput[];
  const groups = assignDedupeGroups(rows);
  const update = db.prepare('UPDATE events SET dedupe_group = ? WHERE id = ?');
  for (const [id, group] of groups) update.run(group, id);
}

export function getStatuses(): SourceStatus[] {
  const rows = db.prepare('SELECT name, state, message, last_fetch AS lastFetch, count FROM source_status').all() as unknown as {
    name: string;
    state: SourceStatus['state'];
    message: string;
    lastFetch: string | null;
    count: number;
  }[];
  const byName = new Map(rows.map((r) => [r.name, r]));
  return ADAPTERS.map((a) => {
    const row = byName.get(a.name);
    return {
      name: a.name,
      label: a.label,
      unofficial: Boolean(a.unofficial),
      state: row?.state ?? 'never_run',
      message: row?.message ?? 'Not fetched yet',
      lastFetch: row?.lastFetch ?? null,
      count: row?.count ?? 0,
    };
  });
}
