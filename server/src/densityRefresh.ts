import { getKv, setKv, getSettings } from './db.js';
import { runDiscover, runScrape, runWaze, runWazeSignIn, listAreas, AreaSummary } from './density/pipeline.js';
import { resolveAreas } from './density/areas.js';

/**
 * Density sampling as one of event-scout's background tasks.
 *
 * Deliberately on its own schedule, separate from `refreshAll`: events change a
 * few times a day, but venue busyness is only meaningful sampled every half
 * hour or so. A pass opens one page per venue and takes minutes, so overlapping
 * runs are refused rather than queued.
 */

let running = false;
let lastLog: string[] = [];

export interface DensityStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastRun: string | null;
  lastResult: string | null;
  nextDue: string | null;
  areas: AreaSummary[];
  log: string[];
}

export function isDensityRunning(): boolean {
  return running;
}

export function getDensityStatus(): DensityStatus {
  const settings = getSettings();
  const lastRun = getKv('densityLastRun');
  const interval = Math.max(5, settings.densityIntervalMinutes ?? 60);
  let areas: AreaSummary[] = [];
  try {
    areas = listAreas();
  } catch {
    areas = [];
  }
  return {
    enabled: Boolean(settings.densityEnabled),
    running,
    intervalMinutes: interval,
    lastRun,
    lastResult: getKv('densityLastResult'),
    nextDue: lastRun ? new Date(Date.parse(lastRun) + interval * 60_000).toISOString() : null,
    areas,
    log: lastLog,
  };
}

function collector(): { log: (msg: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (msg: string) => {
      lines.push(msg);
      if (lines.length > 200) lines.shift();
    },
  };
}

/** Sample every configured area once. */
export async function refreshDensity(force = false): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: 'Density sampling already running' };

  const settings = getSettings();
  if (!force && !settings.densityEnabled) return { ok: false, message: 'Density sampling is disabled' };
  if (resolveAreas().length === 0) {
    return { ok: false, message: 'No areas configured - set a location in Settings' };
  }

  running = true;
  const { log, lines } = collector();
  try {
    const result = await runScrape(settings.densityCities ?? [], log);
    const summary = result.areas
      .map((a) => (a.ok ? `${a.name}: ${a.observations ?? 0} obs` : `${a.name}: ${a.error}`))
      .join('; ');
    setKv('densityLastRun', new Date().toISOString());
    setKv('densityLastResult', summary || 'no areas');
    lastLog = lines;
    return { ok: result.ok, message: summary || 'no areas configured' };
  } catch (err) {
    const message = (err as Error).message;
    setKv('densityLastRun', new Date().toISOString());
    setKv('densityLastResult', `failed: ${message}`);
    lastLog = [...lines, `failed: ${message}`];
    return { ok: false, message };
  } finally {
    running = false;
  }
}

/**
 * A Waze-only pass, triggered by hand.
 *
 * Separate from the full density run because it opens a visible browser window
 * and can be asked to hold it open: the live map is meant to be driven while
 * this runs, and nobody wants that happening on a timer.
 */
export async function refreshWaze(holdSeconds = 0): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: 'Density sampling already running' };
  running = true;
  const { log, lines } = collector();
  try {
    const results = await runWaze(getSettings().densityCities ?? [], holdSeconds, log);
    lastLog = lines;
    const message = results
      .map((r) => (r.ok ? `${r.name}: ${r.observations} observations` : `${r.name}: ${r.error}`))
      .join('; ');
    return { ok: results.some((r) => r.ok), message: message || 'no areas configured' };
  } catch (err) {
    lastLog = [...lines, `failed: ${(err as Error).message}`];
    return { ok: false, message: (err as Error).message };
  } finally {
    running = false;
  }
}

/** Open the live map so the user can sign in to Waze in the window. */
export async function wazeSignIn(holdSeconds = 180): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: 'Density sampling already running' };
  running = true;
  const { log, lines } = collector();
  try {
    const res = await runWazeSignIn(holdSeconds, log);
    lastLog = lines;
    return { ok: res.signedIn, message: res.message };
  } catch (err) {
    lastLog = [...lines, `failed: ${(err as Error).message}`];
    return { ok: false, message: (err as Error).message };
  } finally {
    running = false;
  }
}

/** Rebuild venue lists. Slow and rarely needed, so never automatic. */
export async function discoverVenues(): Promise<{ ok: boolean; message: string }> {
  if (running) return { ok: false, message: 'Density sampling already running' };
  running = true;
  const { log, lines } = collector();
  try {
    const results = await runDiscover(getSettings().densityCities ?? [], log);
    lastLog = lines;
    const message = results
      .map((r) => (r.ok ? `${r.name}: ${r.observations} venues` : `${r.name}: ${r.error}`))
      .join('; ');
    return { ok: results.some((r) => r.ok), message: message || 'no areas configured' };
  } catch (err) {
    lastLog = [...lines, `failed: ${(err as Error).message}`];
    return { ok: false, message: (err as Error).message };
  } finally {
    running = false;
  }
}

/** Called on a timer; runs only when enabled and the interval has elapsed. */
export async function refreshDensityIfDue(): Promise<void> {
  const settings = getSettings();
  if (!settings.densityEnabled || running) return;

  const interval = Math.max(5, settings.densityIntervalMinutes ?? 60) * 60_000;
  const last = getKv('densityLastRun');
  if (last && Date.now() - Date.parse(last) < interval) return;

  const result = await refreshDensity();
  console.log(`Density sampling: ${result.message}`);
}
