import cron from 'node-cron';
import { tasks } from './tasks.js';

/**
 * One cron entry per scheduled task, replacing the four that were written out
 * by hand at the foot of index.ts.
 *
 * Every tick asks the registry rather than deciding for itself, so whether a
 * task is switched on and whether its interval has elapsed are read fresh each
 * time. That is what lets both be changed from the UI without a restart.
 */
export function startScheduler(): void {
  for (const def of tasks.list()) {
    if (!def.schedule) continue;
    cron.schedule(def.schedule, () => {
      void tasks
        .runIfDue(def.name)
        .then((result) => {
          if (result) console.log(`[${def.name}] ${result.message}`);
        })
        .catch((err: Error) => console.error(`[${def.name}] failed: ${err.message}`));
    });
  }
}

/**
 * The catch-up pass at startup.
 *
 * A process that has been down for a day should not wait for the next tick to
 * notice, and archiving in particular decides what the front page shows. Given
 * a beat first so the server is listening before anything slow begins.
 */
export function runDueTasksOnStartup(delayMs = 5000): void {
  setTimeout(() => {
    void (async () => {
      for (const def of tasks.list()) {
        if (!def.schedule) continue;
        try {
          const result = await tasks.runIfDue(def.name);
          if (result) console.log(`[${def.name}] ${result.message}`);
        } catch (err) {
          console.error(`[${def.name}] failed: ${(err as Error).message}`);
        }
      }
    })();
  }, delayMs);
}
