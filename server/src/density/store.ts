import { db } from '../db.js';

/**
 * Density storage, living in event-scout's own database.
 *
 * Three tables: one row per scrape pass, one row per weighted observation, and
 * a venue cache. Venues used to be a JSON file per city; keeping them here
 * means one database, and lets the weekly profile sit alongside the venue it
 * describes.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS density_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  area        TEXT    NOT NULL,
  bbox        TEXT    NOT NULL,
  summary     TEXT    NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS density_observations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  INTEGER NOT NULL REFERENCES density_runs(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  area    TEXT    NOT NULL,
  source  TEXT    NOT NULL,
  kind    TEXT,
  lat     REAL    NOT NULL,
  lon     REAL    NOT NULL,
  weight  REAL    NOT NULL,
  meta    TEXT
);
CREATE INDEX IF NOT EXISTS idx_dobs_ts     ON density_observations(ts);
CREATE INDEX IF NOT EXISTS idx_dobs_area   ON density_observations(area);
CREATE INDEX IF NOT EXISTS idx_dobs_source ON density_observations(source);
-- Every read filters on area first, then source, then a time window, so one
-- composite index serves them all; the single-column ones above could only
-- ever satisfy a third of each query.
CREATE INDEX IF NOT EXISTS idx_dobs_lookup ON density_observations(area, source, ts);

CREATE TABLE IF NOT EXISTS density_venues (
  area     TEXT NOT NULL,
  cid      TEXT NOT NULL,
  name     TEXT NOT NULL,
  kgmid    TEXT NOT NULL,
  lat      REAL NOT NULL,
  lon      REAL NOT NULL,
  term     TEXT DEFAULT '',
  profile  TEXT,
  PRIMARY KEY (area, cid)
);
`);

/**
 * How many passes in a row a venue has shown no popular-times panel at all.
 *
 * Google simply does not publish popular times for most car parks, sports
 * grounds and small restaurants, and a venue that has none looks identical to
 * one whose panel is merely slow: both are an empty page until the timeout
 * expires. Counting the misses tells the two apart over time, so the scraper
 * can stop spending its full patience on places that have never had a panel.
 * Added here so existing databases pick it up.
 */
{
  const cols = (db.prepare('PRAGMA table_info(density_venues)').all() as unknown as { name: string }[])
    .map((c) => c.name);
  if (!cols.includes('barren_streak')) {
    db.exec('ALTER TABLE density_venues ADD COLUMN barren_streak INTEGER NOT NULL DEFAULT 0');
  }
}

export interface Venue {
  cid: string;
  name: string;
  kgmid: string;
  lat: number;
  lon: number;
  term: string;
  profile?: WeekProfile | null;
  /** Consecutive passes with no popular-times panel. See the migration above. */
  barrenStreak?: number;
}

export interface WeekProfile {
  busiestDay: string;
  busiestDayIndex: number;
  busiestHour: number;
  busiestPeak: number;
  quietestDay: string;
  openDays: string[];
  byDay: Record<string, Record<string, number>>;
  updatedAt: string;
}

export interface Observation {
  source: string;
  kind?: string | null;
  lat: number;
  lon: number;
  weight: number;
  meta?: Record<string, unknown> | null;
}

export interface StoredObservation extends Observation {
  ts: number;
  area: string;
  meta: Record<string, unknown> | null;
}

function parse<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// --- venues -----------------------------------------------------------------

export function loadVenues(area: string): Venue[] {
  const rows = db
    .prepare(
      `SELECT cid, name, kgmid, lat, lon, term, profile, barren_streak
       FROM density_venues WHERE area = ?`
    )
    .all(area) as unknown as (Omit<Venue, 'profile' | 'barrenStreak'> & {
      profile: string | null; barren_streak: number;
    })[];
  return rows.map(({ barren_streak, ...r }) => ({
    ...r,
    profile: parse<WeekProfile>(r.profile),
    barrenStreak: barren_streak,
  }));
}

export function saveVenues(area: string, venues: Venue[]): void {
  const insert = db.prepare(
    `INSERT INTO density_venues (area, cid, name, kgmid, lat, lon, term, profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(area, cid) DO UPDATE SET
       name = excluded.name, kgmid = excluded.kgmid, lat = excluded.lat,
       lon = excluded.lon, term = excluded.term,
       -- Never overwrite a known profile with nothing.
       profile = COALESCE(excluded.profile, density_venues.profile)`
  );
  db.exec('BEGIN');
  try {
    for (const v of venues) {
      insert.run(area, v.cid, v.name, v.kgmid, v.lat, v.lon, v.term ?? '',
        v.profile ? JSON.stringify(v.profile) : null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Record which venues showed a panel this pass and which did not.
 *
 * Separate from `saveVenues` because it runs after every pass, including the
 * common one where no profile changed at all: writing the whole venue row back
 * just to bump a counter would rewrite the profile JSON for no reason.
 */
export function recordPanelChecks(
  area: string, results: { cid: string; sawPanel: boolean }[]
): void {
  const hit = db.prepare('UPDATE density_venues SET barren_streak = 0 WHERE area = ? AND cid = ?');
  const miss = db.prepare(
    'UPDATE density_venues SET barren_streak = barren_streak + 1 WHERE area = ? AND cid = ?'
  );
  db.exec('BEGIN');
  try {
    for (const r of results) (r.sawPanel ? hit : miss).run(area, r.cid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Replace an area's venue list, keeping profiles for venues that survive. */
export function replaceVenues(area: string, venues: Venue[]): void {
  const keep = new Set(venues.map((v) => v.cid));
  const existing = loadVenues(area);
  for (const v of venues) {
    if (v.profile) continue;
    v.profile = existing.find((e) => e.cid === v.cid)?.profile ?? null;
  }
  db.exec('BEGIN');
  try {
    for (const e of existing) {
      if (!keep.has(e.cid)) {
        db.prepare('DELETE FROM density_venues WHERE area = ? AND cid = ?').run(area, e.cid);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  saveVenues(area, venues);
}

export function venueCount(area: string): number {
  const row = db
    .prepare('SELECT COUNT(*) n FROM density_venues WHERE area = ?')
    .get(area) as unknown as { n: number };
  return row.n;
}

// --- runs and observations --------------------------------------------------

export function insertRun(opts: {
  ts: number; area: string; bbox: unknown; summary: unknown; durationMs: number;
}): number {
  const info = db
    .prepare('INSERT INTO density_runs (ts, area, bbox, summary, duration_ms) VALUES (?, ?, ?, ?, ?)')
    .run(opts.ts, opts.area, JSON.stringify(opts.bbox), JSON.stringify(opts.summary), opts.durationMs);
  return Number(info.lastInsertRowid);
}

export function insertObservations(
  runId: number, ts: number, area: string, observations: Observation[]
): void {
  const stmt = db.prepare(
    `INSERT INTO density_observations (run_id, ts, area, source, kind, lat, lon, weight, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec('BEGIN');
  try {
    for (const o of observations) {
      stmt.run(runId, ts, area, o.source, o.kind ?? null, o.lat, o.lon, o.weight,
        o.meta ? JSON.stringify(o.meta) : null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface SelectOpts {
  area?: string;
  sinceTs?: number;
  hourOfDay?: number;
  daysOfWeek?: number[];
  sources?: string[];
}

export function selectObservations(opts: SelectOpts = {}): StoredObservation[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.area) { where.push('area = ?'); params.push(opts.area); }
  if (opts.sinceTs) { where.push('ts >= ?'); params.push(opts.sinceTs); }
  if (opts.sources?.length) {
    where.push(`source IN (${opts.sources.map(() => '?').join(',')})`);
    params.push(...opts.sources);
  }
  const sql =
    `SELECT ts, area, source, kind, lat, lon, weight, meta FROM density_observations
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;

  let rows = (db.prepare(sql).all(...(params as never[])) as unknown as (StoredObservation & {
    meta: string | null;
  })[]).map((r) => ({ ...r, meta: parse<Record<string, unknown>>(r.meta) }));

  // Local-time filters run in JS so they honour the machine's timezone and DST
  // rather than SQLite's UTC-only date functions.
  if (opts.hourOfDay != null || opts.daysOfWeek?.length) {
    rows = rows.filter((r) => {
      const d = new Date(r.ts * 1000);
      if (opts.hourOfDay != null && d.getHours() !== opts.hourOfDay) return false;
      if (opts.daysOfWeek?.length && !opts.daysOfWeek.includes(d.getDay())) return false;
      return true;
    });
  }
  return rows;
}

export function lastRunFor(area: string): { ts: number; summary: unknown } | null {
  const row = db
    .prepare('SELECT ts, summary FROM density_runs WHERE area = ? ORDER BY ts DESC LIMIT 1')
    .get(area) as unknown as { ts: number; summary: string } | undefined;
  if (!row) return null;
  return { ts: row.ts, summary: parse(row.summary) };
}
