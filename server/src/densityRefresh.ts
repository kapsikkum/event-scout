import { getSettings } from './db.js';
import { runDiscover, runScrape, listAreas, AreaSummary } from './density/pipeline.js';
import { resolveAreas } from './density/areas.js';
import { TaskLog, TaskResult } from './tasks/registry.js';
import { tasks } from './tasks/tasks.js';

/**
 * The density passes, as plain pieces of work.
 *
 * The lock, the bounded log and the last-run bookkeeping all used to live here;
 * they are the task registry's job now, which is what lets these four share one
 * exclusive lock on the browser rather than a module global that only these
 * four knew about. What is left is the work itself.
 */

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

/**
 * The density panel's own view of things.
 *
 * Everything but the area list now comes from the task registry, so the
 * Settings panel and the Tasks page cannot disagree about whether a pass is
 * running or when the last one was.
 */
export function getDensityStatus(): DensityStatus {
  const task = tasks.status('density');
  let areas: AreaSummary[] = [];
  try {
    areas = listAreas();
  } catch {
    areas = [];
  }
  return {
    enabled: task?.enabled ?? false,
    // Any of the four browser passes being in flight is what the panel means
    // by busy: none of them can start while another is going.
    running: Boolean(
      task?.running || task?.blockedBy || tasks.status('densityDiscover')?.running
    ),
    intervalMinutes: task?.intervalMinutes ?? 60,
    lastRun: task?.lastRun ?? null,
    lastResult: task?.lastResult ?? null,
    nextDue: task?.nextDue ?? null,
    areas,
    log: task?.log ?? [],
  };
}

/** Sample every configured area once. */
export async function runDensityScrape(log: TaskLog): Promise<TaskResult> {
  if (resolveAreas().length === 0) {
    return { ok: false, message: 'No areas configured - set a location in Settings' };
  }
  const result = await runScrape(getSettings().densityCities ?? [], log);
  const summary = result.areas
    .map((a) => (a.ok ? `${a.name}: ${a.observations ?? 0} obs` : `${a.name}: ${a.error}`))
    .join('; ');
  return { ok: result.ok, message: summary || 'no areas configured' };
}

/** Rebuild venue lists. Slow and rarely needed, so never on a schedule. */
export async function runVenueDiscovery(log: TaskLog): Promise<TaskResult> {
  const results = await runDiscover(getSettings().densityCities ?? [], log);
  const message = results
    .map((r) => (r.ok ? `${r.name}: ${r.observations} venues` : `${r.name}: ${r.error}`))
    .join('; ');
  return { ok: results.some((r) => r.ok), message: message || 'no areas configured' };
}
