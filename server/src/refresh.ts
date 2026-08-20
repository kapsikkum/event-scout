import { db, getSettings, setKv } from './db.js';
import { assignDedupeGroups, DedupeInput, haversineKm } from './dedupe.js';
import { photoScore } from './photoScore.js';
import { eventbrite } from './sources/eventbrite.js';
import { facebook } from './sources/facebook.js';
import { icalSource } from './sources/ical.js';
import { seatgeek } from './sources/seatgeek.js';
import { ticketmaster } from './sources/ticketmaster.js';
import { websearch } from './sources/websearch.js';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, SourceStatus } from './sources/types.js';
import { geocode, isGeocodeCached } from './geocode.js';
import { classifyEvent } from './sources/topics.js';
import { cleanAddress, cleanDescription, validateAddress, validateDates, validateLocation } from './validate.js';
import { localitiesFrom, unifyVenueNames } from './venues.js';
import { defaultRegionFrom } from './regions.js';

export const ADAPTERS: EventSourceAdapter[] = [ticketmaster, seatgeek, eventbrite, facebook, websearch, icalSource];

let refreshing = false;

/** Search queries one refresh may spend in total, across every area. */
const TOTAL_QUERY_BUDGET = 18;

/** Breathing room between areas, for the same reason as the per-query spacing. */
const AREA_SPACING_MS = 2500;

export function isRefreshing(): boolean {
  return refreshing;
}

const upsertStmt = () =>
  db.prepare(`
    INSERT INTO events (source, source_id, title, description, start_time, end_time, venue_name, address,
                        lat, lng, url, image_url, category, price_text, is_online, photo_score, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      venue_name = excluded.venue_name,
      address = excluded.address,
      lat = excluded.lat,
      lng = excluded.lng,
      url = excluded.url,
      image_url = excluded.image_url,
      category = excluded.category,
      price_text = excluded.price_text,
      is_online = excluded.is_online,
      photo_score = excluded.photo_score,
      last_seen_at = excluded.last_seen_at
  `);

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
  if (refreshing) throw new Error('A refresh is already running');
  refreshing = true;
  try {
    const settings = getSettings();
    if (settings.lat == null || settings.lng == null) {
      throw new Error('Set a location in Settings before refreshing');
    }
    const locations = await eventLocations(settings);
    const now = new Date().toISOString();

    const results = await Promise.allSettled(
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

        for (const [i, loc] of locations.entries()) {
          try {
            if (i > 0) await new Promise((r) => setTimeout(r, AREA_SPACING_MS));
            const raw = await adapter.fetchEvents(loc, settings);
            // Sources are not trustworthy about dates: recurring-event pages
            // keep last year's startDate in their markup, and a stale one
            // sails through as a real listing unless it is checked here.
            const kept: RawEvent[] = [];
            for (const ev of raw) {
              const dates = validateDates(ev);
              if (!dates.ok) {
                rejected.push(`${ev.title}: ${dates.reason}`);
                continue;
              }
              const where = validateLocation(ev, [loc]);
              if (!where.ok) continue;
              kept.push({ ...ev, startTime: dates.startTime, endTime: dates.endTime ?? undefined });
            }
            const stmt = upsertStmt();
            for (const ev of kept) insertRaw(stmt, adapter.name, ev, now, localRegion());
            total += kept.length;
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

        if (missing) {
          setStatus(adapter.name, 'missing_config', missing.message, null);
        } else if (failures.length === locations.length && locations.length > 0) {
          // The same feed failing in every area is one fault, not N.
          const reasons = [...new Set(failures.map((f) => f.slice(f.indexOf(': ') + 2)))];
          setStatus(
            adapter.name, 'error',
            reasons.length === 1 ? reasons[0] : failures.join('; '), null
          );
        } else {
          const where = locations.length > 1 ? ` across ${locations.length} areas` : '';
          const partly = failures.length ? ` (${failures.length} area failed)` : '';
          // Worth saying out loud: a source that suddenly has everything
          // rejected is a parser that has broken, not a quiet week.
          const dropped = rejected.length ? `, ${rejected.length} rejected on date` : '';
          setStatus(adapter.name, 'ok', `Fetched ${total} events${where}${dropped}${partly}`, total);
          if (rejected.length) console.warn(`[${adapter.name}] rejected: ${rejected.slice(0, 10).join('; ')}`);
        }
      })
    );
    void results;

    repairImplausibleDates();
    repairAddresses();
    repairVenueNames();
    archivePastEvents();
    reclassifyAll();
    await geocodeMissing(locations);

    recomputeDedupeGroups();
    setKv('lastRefresh', now);
    return getStatuses();
  } finally {
    refreshing = false;
  }
}

/** Venues resolved per refresh. Nominatim asks for one request a second. */
const GEOCODE_BUDGET = 60;
const GEOCODE_SPACING_MS = 1100;

/**
 * Put coordinates on events that arrived without any.
 *
 * Most sources give a venue name and no position, which left 103 of 138 events
 * invisible on the map — they were being fetched and stored perfectly well and
 * simply had nowhere to be drawn. The venue name is enough to place them.
 *
 * A result is only accepted if it lands inside one of the configured areas.
 * Venue names are generic ("The Victoria", "Royal Hotel") and Nominatim will
 * happily return the London one, which would scatter pins across the planet.
 * Lookups are cached, so a venue costs one request ever.
 */
async function geocodeMissing(locations: Location[]): Promise<number> {
  if (locations.length === 0) return 0;
  const rows = db
    .prepare(
      `SELECT id, venue_name, address FROM events
       WHERE lat IS NULL AND archived = 0 AND geocode_tried = 0
         AND (venue_name != '' OR address != '')
       ORDER BY start_time LIMIT ?`
    )
    .all(GEOCODE_BUDGET) as unknown as { id: number; venue_name: string; address: string }[];
  if (rows.length === 0) return 0;

  const update = db.prepare('UPDATE events SET lat = ?, lng = ?, geocode_tried = 1 WHERE id = ?');
  const markTried = db.prepare('UPDATE events SET geocode_tried = 1 WHERE id = ?');
  let placed = 0;

  for (const row of rows) {
    const queries = geocodeCandidates(row.venue_name, row.address, locations);
    if (queries.length === 0) {
      markTried.run(row.id);
      continue;
    }
    let found: { lat: number; lng: number } | null = null;
    let errored = false;

    for (const query of queries) {
      try {
        // Only a real network call needs the rate limit; a cached answer is
        // free, so a backlog of previously-seen venues clears in one pass.
        if (!isGeocodeCached(query)) await new Promise((r) => setTimeout(r, GEOCODE_SPACING_MS));
        const hits = await geocode(query);
        const hit = hits.find((h) =>
          locations.some((loc) => haversineKm(loc.lat, loc.lng, h.lat, h.lng) <= loc.radiusKm * 1.5)
        );
        if (hit) {
          found = hit;
          break;
        }
      } catch {
        errored = true;
      }
    }

    if (found) {
      update.run(found.lat, found.lng, row.id);
      placed++;
    } else if (!errored) {
      // Genuinely unplaceable rather than a transient failure, so stop asking.
      markTried.run(row.id);
    }
  }
  return placed;
}

/** Attempts per event, so one stubborn venue cannot eat the whole budget. */
const GEOCODE_ATTEMPTS = 4;

/**
 * Queries to try for one event, best first.
 *
 * Nominatim is free-text but not forgiving: "Australian Fossil and Mineral
 * Museum, 224 Howick Street, Bathurst" returns nothing at all, while the street
 * address alone resolves immediately. Leading with the venue name — the obvious
 * thing to do — was why most events stayed unplaced. A bare street number with
 * no town is the opposite problem: "169 COLLEGE ROAD" matched a road in North
 * Carolina, so those get an area name appended.
 */
export function geocodeCandidates(
  venue: string, address: string, locations: { city: string }[]
): string[] {
  const out: string[] = [];
  const push = (q: string): void => {
    const trimmed = q.trim().replace(/^,|,$/g, '').trim().slice(0, 200);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  const cities = locations.map((l) => l.city).filter(Boolean);
  const hasLocality = (text: string): boolean =>
    cities.some((c) => text.toLowerCase().includes(c.toLowerCase().split(',')[0].trim()));

  if (address) {
    if (hasLocality(address)) push(address);
    else for (const city of cities) push(`${address}, ${city}`);
  }
  if (venue) {
    if (hasLocality(venue)) push(venue);
    else for (const city of cities) push(`${venue}, ${city}`);
  }
  if (venue && address) push(`${venue}, ${address}`);
  // "Mount Panorama Racing Circuit, Bathurst, NSW, Australia" finds nothing,
  // where the bare name sometimes does. Worth one attempt at the head of it.
  if (venue.includes(',')) push(venue.split(',')[0]);
  return out.slice(0, GEOCODE_ATTEMPTS);
}

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
              OR julianday(end_time) - julianday(start_time) > 21)`
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
 * Move events that finished (or started, if they carry no end) more than a day
 * ago into the archive, rather than deleting them. Very old archived rows are
 * eventually purged so the database stays bounded, but anything starred is
 * kept indefinitely.
 */
export function archivePastEvents(): { archived: number; purged: number } {
  const now = Date.now();
  const cutoff = new Date(now - 24 * 3600 * 1000).toISOString();
  const archived = db
    .prepare(
      `UPDATE events SET archived = 1, archived_at = ?
       WHERE archived = 0 AND COALESCE(end_time, start_time) < ?`
    )
    .run(new Date(now).toISOString(), cutoff).changes;

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
    classifyEvent(ev.title, ev.description ?? '', ev.category ?? ''),
    ev.priceText ?? '',
    ev.isOnline ? 1 : 0,
    photoScore(ev),
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
    .prepare('SELECT id, title, description, category FROM events')
    .all() as unknown as { id: number; title: string; description: string; category: string }[];
  const update = db.prepare('UPDATE events SET category = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    // The stored category may itself be a previous verdict, so classify from
    // the text alone and let the source's original value stay out of it.
    const next = classifyEvent(row.title, row.description ?? '', '');
    if (next !== row.category) {
      update.run(next, row.id);
      changed++;
    }
  }
  return changed;
}

function recomputeDedupeGroups(): void {
  const rows = db.prepare('SELECT id, title, start_time AS startTime, lat, lng FROM events').all() as unknown as DedupeInput[];
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
