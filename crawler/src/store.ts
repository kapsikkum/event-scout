import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ensureDataDir } from './config.js';
import { CrawledEvent } from './types.js';
import { siteOf } from './urls.js';

/**
 * The crawler's own memory, in its own file.
 *
 * Separate from event-scout's database on purpose. This one is churn — a
 * frontier of hundreds of thousands of URLs, rewritten constantly — and it has
 * no business sharing a file with the thing that holds a year of history and
 * gets copied to the NAS every night. Nothing here is precious: delete it and
 * the crawler rebuilds it from the seeds.
 *
 * The memory is also the point. event-scout's websearch pass re-searches from
 * nothing every cycle and throws away what it learned; a page that has yielded
 * an event before is the best guess about where the next one is, and that is
 * only usable if it is written down.
 */

const db = new DatabaseSync(path.join(ensureDataDir(), 'crawler.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  discovered_at TEXT NOT NULL,
  fetched_at TEXT,
  events INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pages_pick ON pages(state, score DESC);
CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(site);

CREATE TABLE IF NOT EXISTS finds (
  id TEXT PRIMARY KEY,
  start_time TEXT NOT NULL,
  found_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finds_start ON finds(start_time);

CREATE TABLE IF NOT EXISTS hosts (
  site TEXT PRIMARY KEY,
  robots TEXT NOT NULL DEFAULT '',
  robots_at TEXT,
  crawl_delay_ms INTEGER,
  last_fetch_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feeds (
  url TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  found_at TEXT NOT NULL,
  found_on TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seeds (
  url TEXT PRIMARY KEY,
  added_at TEXT NOT NULL
);
`);

const now = (): string => new Date().toISOString();

// --- the frontier -----------------------------------------------------------

/**
 * Offer a URL to the frontier.
 *
 * Silent about duplicates, which is most of what it is asked: a site's every
 * page links to its front page. A URL already known keeps the shallower depth
 * and the better score, so arriving again by a worse route cannot demote it.
 */
export function offer(url: string, depth: number, score: number): boolean {
  const existing = db.prepare('SELECT depth, score FROM pages WHERE url = ?').get(url) as
    | { depth: number; score: number }
    | undefined;
  if (existing) {
    if (depth < existing.depth || score > existing.score) {
      db.prepare('UPDATE pages SET depth = MIN(depth, ?), score = MAX(score, ?) WHERE url = ?')
        .run(depth, score, url);
    }
    return false;
  }
  db.prepare(
    'INSERT INTO pages (url, site, depth, score, state, discovered_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(url, siteOf(url), depth, score, 'queued', now());
  return true;
}

/**
 * The next pages worth fetching, best first and at most one per site.
 *
 * One per site is what makes politeness possible without a scheduler: the
 * caller fetches this batch in parallel knowing no two requests can land on the
 * same host, then comes back for more.
 */
export function nextBatch(size: number, excludeSites: string[] = []): { url: string; depth: number }[] {
  const skip = new Set(excludeSites);
  const rows = db
    .prepare(
      `SELECT url, site, depth FROM pages
        WHERE state = 'queued' AND depth <= ?
        ORDER BY score DESC, discovered_at ASC
        LIMIT ?`
    )
    .all(config.maxDepth, size * 20) as { url: string; site: string; depth: number }[];

  const out: { url: string; depth: number }[] = [];
  const used = new Set<string>();
  for (const row of rows) {
    if (skip.has(row.site) || used.has(row.site)) continue;
    used.add(row.site);
    out.push({ url: row.url, depth: row.depth });
    if (out.length >= size) break;
  }
  return out;
}

export function markDone(url: string, events: number, note = ''): void {
  db.prepare('UPDATE pages SET state = ?, fetched_at = ?, events = ?, note = ? WHERE url = ?')
    .run('done', now(), events, note, url);
}

export function markFailed(url: string, note: string, permanent = false): void {
  db.prepare('UPDATE pages SET state = ?, fetched_at = ?, note = ? WHERE url = ?')
    .run(permanent ? 'skipped' : 'failed', now(), note.slice(0, 200), url);
}

/**
 * Put pages that produced events back in the queue.
 *
 * A listing page is not finished when it has been read once — next week it has
 * different events on it. Pages that yielded nothing are left alone, so the
 * crawl converges on the parts of the web that actually publish events.
 */
export function requeueProductive(olderThanHours: number): number {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();
  return db
    .prepare(
      `UPDATE pages SET state = 'queued'
        WHERE state = 'done' AND events > 0 AND (fetched_at IS NULL OR fetched_at < ?)`
    )
    .run(cutoff).changes as number;
}

export function countPages(): Record<string, number> {
  const out: Record<string, number> = { queued: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of db.prepare('SELECT state, COUNT(*) n FROM pages GROUP BY state').all() as {
    state: string;
    n: number;
  }[]) {
    out[row.state] = row.n;
  }
  return out;
}

// --- what was found ---------------------------------------------------------

/** Keep a find, replacing any earlier reading of the same event. */
export function keep(event: CrawledEvent): void {
  db.prepare('INSERT OR REPLACE INTO finds (id, start_time, found_at, payload) VALUES (?, ?, ?, ?)')
    .run(event.sourceId, event.startTime, event.foundAt, JSON.stringify(event));
}

/** Everything still ahead, newest find first. event-scout filters by area. */
export function finds(limit = 5000): CrawledEvent[] {
  const rows = db
    .prepare(
      `SELECT payload FROM finds WHERE start_time > ? ORDER BY found_at DESC LIMIT ?`
    )
    .all(new Date(Date.now() - 86400_000).toISOString(), limit) as { payload: string }[];
  const out: CrawledEvent[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload) as CrawledEvent);
    } catch {
      // A row that will not parse is a row worth ignoring, not a crash.
    }
  }
  return out;
}

export function countFinds(): number {
  return (db.prepare('SELECT COUNT(*) n FROM finds').get() as { n: number }).n;
}

/** Drop events long past. Nothing here is a record worth keeping. */
export function tidyFinds(): number {
  const cutoff = new Date(Date.now() - config.keepFindsDays * 86400_000).toISOString();
  return db.prepare('DELETE FROM finds WHERE start_time < ?').run(cutoff).changes as number;
}

// --- hosts ------------------------------------------------------------------

export interface HostRow {
  site: string;
  robots: string;
  robots_at: string | null;
  crawl_delay_ms: number | null;
  last_fetch_at: string | null;
  failures: number;
}

export function host(site: string): HostRow | undefined {
  return db.prepare('SELECT * FROM hosts WHERE site = ?').get(site) as HostRow | undefined;
}

export function rememberRobots(site: string, body: string, crawlDelayMs: number | null): void {
  db.prepare(
    `INSERT INTO hosts (site, robots, robots_at, crawl_delay_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(site) DO UPDATE SET robots = excluded.robots, robots_at = excluded.robots_at,
       crawl_delay_ms = excluded.crawl_delay_ms`
  ).run(site, body, now(), crawlDelayMs);
}

export function touchHost(site: string, failed = false): void {
  db.prepare(
    `INSERT INTO hosts (site, last_fetch_at, failures) VALUES (?, ?, ?)
     ON CONFLICT(site) DO UPDATE SET last_fetch_at = excluded.last_fetch_at,
       failures = CASE WHEN ? THEN hosts.failures + 1 ELSE 0 END`
  ).run(site, now(), failed ? 1 : 0, failed ? 1 : 0);
}

/**
 * Sites fetched too recently to touch again.
 *
 * Politeness as a filter on what may be picked, rather than as a sleep inside
 * a worker: a worker that waits its turn is a worker doing nothing, and there
 * is always another site in the queue. `crawl_delay_ms` is the site's own
 * asking price where it named one, clamped by the caller.
 */
export function sitesOnCooldown(defaultDelayMs: number, maxDelayMs: number): string[] {
  const rows = db
    .prepare('SELECT site, last_fetch_at, crawl_delay_ms FROM hosts WHERE last_fetch_at IS NOT NULL')
    .all() as { site: string; last_fetch_at: string; crawl_delay_ms: number | null }[];
  const out: string[] = [];
  for (const row of rows) {
    const wait = Math.min(Math.max(row.crawl_delay_ms ?? 0, defaultDelayMs), maxDelayMs);
    if (Date.now() - Date.parse(row.last_fetch_at) < wait) out.push(row.site);
  }
  return out;
}

/** Feeds are handed to event-scout, which already reads iCal properly. */
export function rememberFeed(url: string, foundOn: string): void {
  db.prepare('INSERT OR IGNORE INTO feeds (url, site, found_at, found_on) VALUES (?, ?, ?, ?)')
    .run(url, siteOf(url), now(), foundOn);
}

export function feeds(): { url: string; site: string; foundOn: string }[] {
  return (
    db.prepare('SELECT url, site, found_on FROM feeds ORDER BY found_at DESC LIMIT 500').all() as {
      url: string;
      site: string;
      found_on: string;
    }[]
  ).map((r) => ({ url: r.url, site: r.site, foundOn: r.found_on }));
}

// --- what to look for -------------------------------------------------------

/** Pinned pages, and pages read on request, go to the front of the queue. */
export const PINNED_SCORE = 50;

export function getJson<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function listSeeds(): string[] {
  return (db.prepare('SELECT url FROM seeds ORDER BY added_at').all() as { url: string }[]).map((r) => r.url);
}

/**
 * Make the pinned pages exactly this list.
 *
 * Replace rather than add, so a page taken out of Settings stops being read.
 * A newly pinned one goes to the front of the queue at once, even if the crawl
 * had already been there: being asked for is a reason to look again.
 */
export function pinSeeds(urls: string[]): { added: number; removed: number } {
  const want = new Set(urls);
  const have = new Set(listSeeds());
  let added = 0;
  let removed = 0;
  for (const url of have) {
    if (want.has(url)) continue;
    db.prepare('DELETE FROM seeds WHERE url = ?').run(url);
    removed++;
  }
  for (const url of want) {
    if (have.has(url)) continue;
    db.prepare('INSERT OR IGNORE INTO seeds (url, added_at) VALUES (?, ?)').run(url, now());
    offer(url, 0, PINNED_SCORE);
    db.prepare("UPDATE pages SET state = 'queued', depth = 0, score = MAX(score, ?) WHERE url = ?")
      .run(PINNED_SCORE, url);
    added++;
  }
  return { added, removed };
}

/**
 * Put the pinned pages back at the front of the queue, once they are due.
 *
 * Every few hours rather than every cycle: a what's-on page changes weekly at
 * most, and reading it every half hour would be exactly the kind of attention
 * robots.txt exists to discourage.
 */
export function requeueSeeds(olderThanHours: number): number {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();
  let n = 0;
  for (const url of listSeeds()) {
    if (offer(url, 0, PINNED_SCORE)) {
      n++;
      continue;
    }
    n += db
      .prepare(
        `UPDATE pages SET state = 'queued', depth = 0, score = MAX(score, ?)
          WHERE url = ? AND state != 'queued' AND (fetched_at IS NULL OR fetched_at < ?)`
      )
      .run(PINNED_SCORE, url, cutoff).changes as number;
  }
  return n;
}
