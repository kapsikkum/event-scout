import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ensureDataDir } from './config.js';
import { CrawledEvent } from './types.js';
import { siteOf } from './urls.js';
import { postTime, SocialLink, STALE_POST_DAYS } from './extract/social.js';
import { findKey } from './extract/jsonld.js';

/**
 * The crawler's own memory, in its own file.
 *
 * Separate from event-scout's database on purpose. This one is churn — a
 * frontier of hundreds of thousands of URLs, rewritten constantly — and it has
 * no business sharing a file with the thing that holds a year of history and
 * gets backed up every night. Nothing here is precious: delete it and
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

/**
 * One row per finished cycle, for the graph on the crawler's page.
 *
 * The frontier says where the crawl is and nothing about how it got there;
 * whether the pages read are turning up events, or the queue is only growing,
 * is a question about the last day of cycles. Its own statement so databases
 * made before it pick it up.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS cycles (
  started_at TEXT PRIMARY KEY,
  finished_at TEXT NOT NULL,
  fetched INTEGER NOT NULL,
  events INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  blocked INTEGER NOT NULL,
  seeded INTEGER NOT NULL,
  feeds INTEGER NOT NULL,
  queued INTEGER NOT NULL,
  finds INTEGER NOT NULL
);
`);

/**
 * Facebook events the crawl came across, for event-scout to read.
 *
 * Not in the frontier: the crawler never fetches them. event-scout has a
 * parser for Facebook's event pages and the crawler has no business carrying
 * a second one, so it only writes the link down.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS social (
  url TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  found_at TEXT NOT NULL,
  found_on TEXT NOT NULL
);
`);

/**
 * How many times each page has been read, for the crawler's page.
 *
 * Added after the table was, so an existing database gets it here. A duplicate
 * is success: two processes opening one file can both try.
 */
try {
  db.exec('ALTER TABLE pages ADD COLUMN reads INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column/i.test((err as Error).message)) throw err;
}

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
  db.prepare('UPDATE pages SET state = ?, fetched_at = ?, events = ?, note = ?, reads = reads + 1 WHERE url = ?')
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
        WHERE state = 'done' AND events > 0 AND site != 'instagram.com'
          AND (fetched_at IS NULL OR fetched_at < ?)`
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

// --- history ----------------------------------------------------------------

/** A finished cycle, with the queue and the finds as they stood at its end. */
export interface CycleRow {
  startedAt: string;
  finishedAt: string;
  fetched: number;
  events: number;
  failed: number;
  blocked: number;
  seeded: number;
  feeds: number;
  /** Pages waiting when it finished. */
  queued: number;
  /** Events held when it finished. */
  finds: number;
}

/** Cycles kept. At the default half-hour interval, about four days. */
const KEEP_CYCLES = 200;

export function recordCycle(
  r: Pick<CycleRow, 'startedAt' | 'fetched' | 'events' | 'failed' | 'blocked' | 'seeded' | 'feeds'> & {
    finishedAt: string | null;
  }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO cycles
       (started_at, finished_at, fetched, events, failed, blocked, seeded, feeds, queued, finds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    r.startedAt, r.finishedAt ?? now(), r.fetched, r.events, r.failed, r.blocked, r.seeded, r.feeds,
    countPages().queued ?? 0, countFinds()
  );
  db.prepare(
    'DELETE FROM cycles WHERE started_at NOT IN (SELECT started_at FROM cycles ORDER BY started_at DESC LIMIT ?)'
  ).run(KEEP_CYCLES);
}

/** The most recent cycles, oldest first, which is the order a graph reads in. */
export function cycleHistory(limit = 48): CycleRow[] {
  const rows = db
    .prepare(
      `SELECT started_at, finished_at, fetched, events, failed, blocked, seeded, feeds, queued, finds
         FROM cycles ORDER BY started_at DESC LIMIT ?`
    )
    .all(limit) as Record<string, string | number>[];
  return rows.reverse().map((r) => ({
    startedAt: String(r.started_at),
    finishedAt: String(r.finished_at),
    fetched: Number(r.fetched),
    events: Number(r.events),
    failed: Number(r.failed),
    blocked: Number(r.blocked),
    seeded: Number(r.seeded),
    feeds: Number(r.feeds),
    queued: Number(r.queued),
    finds: Number(r.finds),
  }));
}

// --- instagram and facebook -------------------------------------------------

/** Where a post and a profile go in the queue: posts first, since they are what hold events. */
const SOCIAL_POST_SCORE = 15;
const SOCIAL_PROFILE_SCORE = 8;

/**
 * Offer an Instagram or Facebook link.
 *
 * Instagram goes into the frontier at depth 0 — it is off-site from wherever
 * it was linked, and the depth cap is about a site's own links. Facebook
 * events are only written down, for event-scout. True when it was new.
 */
export function offerSocial(link: SocialLink, foundOn: string): boolean {
  if (link.kind === 'facebook-event') {
    return (
      (db
        .prepare('INSERT OR IGNORE INTO social (url, kind, ref, found_at, found_on) VALUES (?, ?, ?, ?, ?)')
        .run(link.url, link.kind, link.id, now(), foundOn.slice(0, 500)).changes as number) > 0
    );
  }
  // A post's shortcode says when it was made, so one from two years ago is
  // passed over without a request: profiles and searches turn up plenty.
  if (link.kind === 'instagram-post') {
    const at = postTime(link.id);
    if (at && Date.now() - at.getTime() > STALE_POST_DAYS * 86400_000) return false;
  }
  return offer(link.url, 0, link.kind === 'instagram-post' ? SOCIAL_POST_SCORE : SOCIAL_PROFILE_SCORE);
}

export function socialLinks(kind: string, limit = 300): { url: string; id: string; foundOn: string; foundAt: string }[] {
  return (
    db
      .prepare('SELECT url, ref, found_on, found_at FROM social WHERE kind = ? ORDER BY found_at DESC LIMIT ?')
      .all(kind, limit) as { url: string; ref: string; found_on: string; found_at: string }[]
  ).map((r) => ({ url: r.url, id: r.ref, foundOn: r.found_on, foundAt: r.found_at }));
}

export function countSocial(): {
  instagramProfiles: number;
  instagramPostsRead: number;
  instagramEvents: number;
  facebookEvents: number;
} {
  const ig = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN url LIKE '%/p/%' THEN 0 ELSE 1 END), 0) AS profiles,
         COALESCE(SUM(CASE WHEN url LIKE '%/p/%' AND state = 'done' THEN 1 ELSE 0 END), 0) AS posts,
         COALESCE(SUM(CASE WHEN url LIKE '%/p/%' THEN events ELSE 0 END), 0) AS events
       FROM pages WHERE site = 'instagram.com'`
    )
    .get() as { profiles: number; posts: number; events: number };
  const fb = db.prepare("SELECT COUNT(*) n FROM social WHERE kind = 'facebook-event'").get() as { n: number };
  return {
    instagramProfiles: Number(ig.profiles),
    instagramPostsRead: Number(ig.posts),
    instagramEvents: Number(ig.events),
    facebookEvents: Number(fb.n),
  };
}

/** Hold a site to a gap of its own, whatever robots.txt did or did not ask for. */
export function setHostDelay(site: string, ms: number): void {
  db.prepare(
    `INSERT INTO hosts (site, crawl_delay_ms) VALUES (?, ?)
     ON CONFLICT(site) DO UPDATE SET crawl_delay_ms = excluded.crawl_delay_ms`
  ).run(site, ms);
}

/**
 * Instagram profiles back in the queue once a day, for their new posts.
 *
 * Posts are never read twice — a caption does not change — so a profile is
 * the only thing that needs coming back to.
 */
export function requeueSocialProfiles(olderThanHours: number): number {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();
  return db
    .prepare(
      `UPDATE pages SET state = 'queued'
        WHERE site = 'instagram.com' AND url NOT LIKE '%/p/%' AND state != 'queued'
          AND (fetched_at IS NULL OR fetched_at < ?)`
    )
    .run(cutoff).changes as number;
}

// --- pages, for the crawler's page ------------------------------------------

export interface PageRow {
  url: string;
  site: string;
  state: string;
  /** Times it has been read successfully. */
  reads: number;
  /** Events on it the last time it was read. */
  events: number;
  fetchedAt: string | null;
  note: string;
}

/** How many times one page has been read. 0 for one it has never read or never heard of. */
export function readsOf(url: string): number {
  const row = db.prepare('SELECT reads FROM pages WHERE url = ?').get(url) as { reads: number } | undefined;
  return row ? Number(row.reads) : 0;
}

/** The pages read most often, or most recently. */
export function pageList(sort: 'reads' | 'recent', limit = 50): PageRow[] {
  const rows = db
    .prepare(
      sort === 'reads'
        ? `SELECT url, site, state, reads, events, fetched_at, note FROM pages
            WHERE reads > 0 ORDER BY reads DESC, fetched_at DESC LIMIT ?`
        : `SELECT url, site, state, reads, events, fetched_at, note FROM pages
            WHERE fetched_at IS NOT NULL ORDER BY fetched_at DESC LIMIT ?`
    )
    .all(limit) as Record<string, string | number | null>[];
  return rows.map((r) => ({
    url: String(r.url),
    site: String(r.site),
    state: String(r.state),
    reads: Number(r.reads),
    events: Number(r.events),
    fetchedAt: r.fetched_at == null ? null : String(r.fetched_at),
    note: String(r.note ?? ''),
  }));
}

// --- once ---------------------------------------------------------------------

/**
 * Fold finds keyed on the page they were read on into the event's own key.
 *
 * See findKey. Once, and oldest first, so where several old rows fold into one
 * the most recent reading is the one kept.
 */
function rekeyFinds(): void {
  if (db.prepare("SELECT 1 FROM kv WHERE key = 'finds-keyed-by-event'").get()) return;
  const rows = db
    .prepare("SELECT id, found_at, payload FROM finds WHERE id LIKE '%#%' ORDER BY found_at ASC")
    .all() as { id: string; found_at: string; payload: string }[];
  const remove = db.prepare('DELETE FROM finds WHERE id = ?');
  const put = db.prepare('INSERT OR REPLACE INTO finds (id, start_time, found_at, payload) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      let ev: CrawledEvent;
      try {
        ev = JSON.parse(row.payload) as CrawledEvent;
      } catch {
        remove.run(row.id);
        continue;
      }
      const id = findKey(ev.url ?? ev.foundOn, ev.title, ev.startTime);
      if (id === row.id) continue;
      remove.run(row.id);
      put.run(id, ev.startTime, row.found_at, JSON.stringify({ ...ev, sourceId: id }));
    }
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('finds-keyed-by-event', ?)").run(JSON.stringify(now()));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
rekeyFinds();
