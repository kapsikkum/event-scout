import path from 'node:path';
import { dataDir, db } from './db.js';
import { assertPublicUrl } from './nethost.js';
import { BROWSER_HEADERS } from './useragent.js';
import {
  extensionFor,
  FLYER_EXTENSIONS,
  FlyerStore,
  flyerDay,
  flyerName,
  flyerRelative,
} from './flyers.js';
import type { TaskLog, TaskResult } from './tasks/registry.js';

/**
 * Filling and pruning the flyer store.
 *
 * The half that reaches the database and the network, kept apart from the path
 * rules in flyers.ts so those can be tested without either.
 */

export const store = new FlyerStore(path.join(dataDir, 'flyers'));

/** Longest a flyer may be. The same guard the reading pass uses. */
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;

/** How many to pull in one pass, so a first run does not sit on the network for an hour. */
const MAX_PER_RUN = 60;

interface Candidate {
  image_url: string;
  start_time: string;
  starred: number;
}

/**
 * What is worth having a copy of.
 *
 * Everything still to come, because that is what the page is showing and what
 * the reading pass will want; and everything shortlisted whenever it happens,
 * because those are the ones being kept. A past event nobody starred is left
 * alone — its cache has stopped earning the space.
 */
function candidates(): Candidate[] {
  return db
    .prepare(
      `SELECT DISTINCT image_url, start_time, starred
         FROM events
        WHERE image_url <> ''
          AND (archived = 0 OR starred = 1)
        ORDER BY starred DESC, start_time ASC`
    )
    .all() as unknown as Candidate[];
}

/** Fetch one flyer, refusing anything that is not a believable image. */
async function download(url: string): Promise<{ bytes: Buffer; extension: string }> {
  // The address comes from a scraped listing, so it is chosen by whoever wrote
  // that listing rather than by anyone here. See nethost.ts.
  await assertPublicUrl(url);
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const extension = extensionFor(res.headers.get('content-type') ?? '');
  if (!extension) throw new Error(`not an image (${res.headers.get('content-type') || 'no type'})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('empty');
  if (bytes.length > MAX_BYTES) throw new Error(`${Math.round(bytes.length / 1e6)} MB is too large`);
  return { bytes, extension };
}

/**
 * What is on disk, as a set, rebuilt at most every few seconds.
 *
 * `getMergedEvents` asks about every image on every call, so the naive version
 * — an existsSync per image per extension — was several thousand stat calls per
 * request against a folder that changes a few times an hour. Reading the names
 * once and answering from memory is the same answer for a fraction of the work.
 */
const INDEX_TTL_MS = 5000;
let index: { at: number; names: Set<string> } | null = null;

function storedIndex(): Set<string> {
  if (index && Date.now() - index.at < INDEX_TTL_MS) return index.names;
  const names = new Set(store.list());
  index = { at: Date.now(), names };
  return names;
}

/** Forget the index, so a write or a prune is visible at once. */
function forgetIndex(): void {
  index = null;
}

/**
 * The stored path for an image, if one exists under any extension.
 *
 * Every extension is tried because the name is derived from the address and the
 * type is only known once it has been fetched.
 */
export function storedPath(imageUrl: string, startTime: string): string | null {
  const names = storedIndex();
  const day = flyerDay(startTime);
  for (const extension of FLYER_EXTENSIONS) {
    const relative = flyerRelative(day, flyerName(imageUrl, extension));
    if (names.has(relative)) return relative;
  }
  return null;
}

/** Fetch the flyers worth keeping that are not on disk yet. */
export async function runFlyerFetch(log: TaskLog): Promise<TaskResult> {
  const wanted = candidates();
  let saved = 0;
  let failed = 0;
  let looked = 0;

  for (const row of wanted) {
    if (saved + failed >= MAX_PER_RUN) break;
    if (storedPath(row.image_url, row.start_time)) continue;
    looked++;
    try {
      const { bytes, extension } = await download(row.image_url);
      store.write(flyerRelative(flyerDay(row.start_time), flyerName(row.image_url, extension)), bytes);
      forgetIndex();
      saved++;
    } catch (err) {
      failed++;
      // Expected often enough not to be worth a line each: a signed URL that
      // has expired is exactly the case this store exists to survive.
      if (failed <= 5) log(`  could not fetch ${row.image_url.slice(0, 70)}: ${(err as Error).message}`);
    }
  }

  const held = store.list().length;
  if (looked === 0) return { ok: true, message: `nothing new to fetch (${held} held)` };
  return {
    ok: true,
    message: `saved ${saved}${failed > 0 ? `, ${failed} unavailable` : ''} (${held} held)`,
  };
}

/**
 * Re-file copies whose event has moved, and drop the ones no longer worth it.
 *
 * Run from the archive task, so the folder is tidied on the same beat as the
 * events themselves and not only when flyers are being fetched.
 */
export function tidyFlyers(): { refiled: number; removed: number } {
  const keep = new Map<string, string>(); // relative path -> where it should be
  for (const row of candidates()) {
    for (const extension of FLYER_EXTENSIONS) {
      const name = flyerName(row.image_url, extension);
      keep.set(name, flyerDay(row.start_time));
    }
  }

  let refiled = 0;
  let removed = 0;
  for (const relative of store.list()) {
    const [day, name] = relative.split('/');
    const wantedDay = keep.get(name);
    if (wantedDay === undefined) {
      if (store.remove(relative)) removed++;
    } else if (wantedDay !== day) {
      if (store.refile(relative, flyerRelative(wantedDay, name))) refiled++;
    }
  }
  store.tidy();
  forgetIndex();
  return { refiled, removed };
}
