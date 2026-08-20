import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, Settings } from './sources/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'event-scout.db'));
db.exec('PRAGMA journal_mode = WAL');

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
