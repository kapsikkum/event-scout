import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, Settings } from './sources/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Where everything this app keeps on disk lives, database and flyers alike. */
export const dataDir = path.resolve(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'event-scout.db'));
db.exec('PRAGMA journal_mode = WAL');
/**
 * Wait for a busy database rather than failing at once.
 *
 * SQLite's default is to give up immediately, which is wrong everywhere this
 * runs: the test files open the same database in parallel processes and raced
 * each other's migrations on a fresh one, and in production the nightly
 * VACUUM INTO backup reads while the app is writing.
 */
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT,
  venue_name TEXT DEFAULT '',
  address TEXT DEFAULT '',
  lat REAL,
  lng REAL,
  url TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  category TEXT DEFAULT '',
  price_text TEXT DEFAULT '',
  is_online INTEGER DEFAULT 0,
  photo_score REAL DEFAULT 0,
  starred INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  dedupe_group TEXT DEFAULT '',
  last_seen_at TEXT,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_time);
CREATE INDEX IF NOT EXISTS idx_events_group ON events(dedupe_group);

CREATE TABLE IF NOT EXISTS source_status (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  message TEXT DEFAULT '',
  last_fetch TEXT,
  count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/**
 * Past events are archived rather than deleted: a year of history is what makes
 * "where was busy last Bathurst 1000" answerable, and it pairs with the
 * density time-series. Added here so existing databases pick it up.
 */
function migrate(): void {
  const cols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('archived')) {
    db.exec('ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('archived_at')) {
    db.exec('ALTER TABLE events ADD COLUMN archived_at TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived)');
  // Manual merges, kept apart from dedupe_group so a refresh cannot undo them:
  // recomputing dedupe groups rewrites that column on every pass.
  if (!cols.includes('manual_group')) {
    db.exec("ALTER TABLE events ADD COLUMN manual_group TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_manual ON events(manual_group)');
  // Remembers that we already tried to place an event. Without it the geocode
  // pass reworks the same earliest rows every refresh and never reaches the rest.
  if (!cols.includes('geocode_tried')) {
    db.exec('ALTER TABLE events ADD COLUMN geocode_tried INTEGER NOT NULL DEFAULT 0');
  }

  /**
   * What a local model made of a listing, kept beside the scraped values
   * rather than on top of them.
   *
   * This is the whole safety of the enrichment pass. `reclassifyAll` and
   * `repairAddresses` rewrite category, address and description on every
   * refresh, so anything written in place would be overwritten within the hour
   * and the two would fight. Apart, the model only ever offers an alternative:
   * turning the task off restores exactly the previous behaviour, and a bad run
   * cannot damage anything that was scraped.
   */
  for (const col of ['llm_description', 'llm_category', 'llm_venue_name', 'llm_address', 'llm_price_text']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.includes('llm_photo_score')) {
    db.exec('ALTER TABLE events ADD COLUMN llm_photo_score REAL');
  }

  /**
   * One row per event already looked at, keyed by a hash of the text that was
   * looked at plus the model and prompt version.
   *
   * Without this every run would re-process the whole database; with it an
   * event costs one inference ever, and is reconsidered only when its own text
   * changes or the model does. Kept in its own table so clearing it — the way
   * to force a re-run — cannot touch the events.
   */
  /**
   * What a person changed by hand, from edit mode on the Events page.
   *
   * The fourth opinion about a listing, and the only one that is always right:
   * these beat the scraped value, the flyer and the model alike. Their own
   * columns for the same reason as the other two — the refresh rewrites the
   * scraped columns on every pass, so anything written over the top would last
   * until the next refresh and no longer. Empty means "not edited", which is
   * what makes clearing a field the way to go back to what was scraped.
   */
  for (const col of [
    'edit_title', 'edit_description', 'edit_start_time', 'edit_venue_name',
    'edit_address', 'edit_category', 'edit_price_text', 'edit_image_url',
  ]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  // Nullable rather than '' because 0 is a meaningful score, so "unset" needs
  // to be a different value from "set to nothing".
  if (!cols.includes('edit_photo_score')) {
    db.exec('ALTER TABLE events ADD COLUMN edit_photo_score REAL');
  }

  /**
   * What a vision model read off the event's flyer. Its own columns, kept apart
   * from both the scraped values and the text model's, so the three can be
   * chosen between rather than overwriting one another.
   */
  for (const col of ['vision_venue_name', 'vision_address', 'vision_price_text', 'vision_note']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_enrichment (
      event_id INTEGER PRIMARY KEY,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 1,
      note TEXT DEFAULT '',
      enriched_at TEXT NOT NULL
    )
  `);

  /** The same bookkeeping for the flyer pass, keyed on the image it read. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_vision (
      event_id INTEGER PRIMARY KEY,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 1,
      note TEXT DEFAULT '',
      read_at TEXT NOT NULL
    )
  `);
}
migrate();

export function getKv(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setKv(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getSettings(): Settings {
  const raw = getKv('settings');
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      enabledSources: { ...DEFAULT_SETTINGS.enabledSources, ...(parsed.enabledSources ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  setKv('settings', JSON.stringify(settings));
}
