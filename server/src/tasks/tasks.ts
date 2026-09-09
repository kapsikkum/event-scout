import { getKv, getSettings, saveSettings, setKv } from '../db.js';
import { archivePastEvents, getProgress, refreshAll } from '../refresh.js';
import {
  runDensityScrape,
  runVenueDiscovery,
  runWazePass,
  runWazeSignInPass,
} from '../densityRefresh.js';
import { createRegistry } from './registry.js';

/**
 * Every background job, registered once.
 *
 * The schedules are the ones these jobs already ran on; nothing here changes
 * how often anything happens. What is new is that each of them can now be asked
 * when it last ran, told to run now, and switched off.
 */

export const tasks = createRegistry({ get: getKv, set: setKv });

/**
 * Carry the bookkeeping these jobs kept for themselves into the registry.
 *
 * Not cosmetic. A task with no last-run is due immediately, so without this an
 * existing install would come back up from this change and at once fire a full
 * event refresh and a density pass — the latter opening a browser — because
 * their history was written under different names. It also keeps the density
 * panel from claiming a pass has never run when one ran ten minutes ago.
 */
function adoptLegacyState(): void {
  if (getKv('task:migrated') === '1') return;
  const carry: [string, string, string][] = [
    // The event refresh has always recorded itself here, and still does: the
    // header and the .ics feed both read it.
    ['lastRefresh', 'task:events:lastRun', 'task:events:lastResult'],
    ['densityLastRun', 'task:density:lastRun', 'task:density:lastResult'],
  ];
  for (const [from, toRun, toResult] of carry) {
    const at = getKv(from);
    if (!at || getKv(toRun)) continue;
    setKv(toRun, at);
    const legacyResult = from === 'densityLastRun' ? getKv('densityLastResult') : null;
    setKv(toResult, legacyResult ?? 'ran before this was recorded');
    setKv(toRun.replace(':lastRun', ':lastOk'), '1');
  }
  setKv('task:migrated', '1');
}
adoptLegacyState();

/**
 * Jobs the user has paused from the Tasks page.
 *
 * Only for the ones with no natural setting of their own. Density and
 * enrichment are switched on and off by the settings that already govern them,
 * so that the Tasks page and their own panels cannot disagree.
 */
function paused(name: string): boolean {
  return (getSettings().tasksDisabled ?? []).includes(name);
}

function setPaused(name: string, off: boolean): void {
  const settings = getSettings();
  const current = new Set(settings.tasksDisabled ?? []);
  if (off) current.add(name);
  else current.delete(name);
  saveSettings({ ...settings, tasksDisabled: [...current] });
}

/**
 * All four browser passes name this, so only one of them can hold a browser at
 * a time. They shared one module-level flag before the registry existed, and
 * the profile directory's lock is exclusive, so this is load-bearing.
 */
const BROWSER = 'browser';

tasks.register({
  name: 'events',
  label: 'Event refresh',
  description: 'Fetch every enabled source across every configured area, then tidy, place and de-duplicate what comes back.',
  // Ticks hourly and refreshes when the cache has gone stale, which is exactly
  // what the old refreshIfStale did.
  schedule: '15 * * * *',
  intervalMinutes: () => 360,
  enabled: () => !paused('events'),
  setEnabled: (on) => setPaused('events', !on),
  run: async (log) => {
    const settings = getSettings();
    if (settings.lat == null || settings.lng == null) {
      return { ok: false, message: 'Set a location in Settings before refreshing' };
    }
    await refreshAll();
    // The refresh keeps its own running commentary for the header display;
    // copying it across means the Tasks page shows the same story afterwards.
    const progress = getProgress();
    for (const line of progress.lines) log(line);
    const found = progress.found;
    return { ok: true, message: `${found} event${found === 1 ? '' : 's'} kept` };
  },
});

tasks.register({
  name: 'archive',
  label: 'Archive past events',
  description: 'Move events that have been and gone into the archive, and purge archived rows old enough to have stopped being history.',
  schedule: '*/10 * * * *',
  intervalMinutes: () => 10,
  enabled: () => !paused('archive'),
  setEnabled: (on) => setPaused('archive', !on),
  run: async (log) => {
    const { archived, purged } = archivePastEvents();
    if (purged > 0) log(`purged ${purged} long-archived row${purged === 1 ? '' : 's'}`);
    return {
      ok: true,
      message:
        archived === 0 && purged === 0
          ? 'nothing to archive'
          : `archived ${archived}${purged > 0 ? `, purged ${purged}` : ''}`,
    };
  },
});

tasks.register({
  name: 'density',
  label: 'Venue density sampling',
  description: 'Open each configured venue and record how busy it is. One page load per venue, so a pass takes minutes.',
  // Ticks far more often than it runs: the interval below is the real spacing,
  // and reading it per tick is what lets a change take effect without a restart.
  schedule: '*/5 * * * *',
  intervalMinutes: () => Math.max(5, getSettings().densityIntervalMinutes ?? 60),
  enabled: () => Boolean(getSettings().densityEnabled),
  setEnabled: (on) => saveSettings({ ...getSettings(), densityEnabled: on }),
  lockGroup: BROWSER,
  run: (log) => runDensityScrape(log),
});

tasks.register({
  name: 'densityDiscover',
  label: 'Rebuild venue list',
  description: 'Re-run venue discovery for every area. Slow, and rarely needed: which venues exist changes far less than how busy they are.',
  enabled: () => true,
  lockGroup: BROWSER,
  run: (log) => runVenueDiscovery(log),
});

tasks.register({
  name: 'waze',
  label: 'Waze live map',
  description: 'Read jams, alerts and wazer positions from the Waze live map. Opens a window, and can be asked to hold it open so the map can be driven by hand.',
  enabled: () => true,
  lockGroup: BROWSER,
  run: (log, arg) => runWazePass(log, arg.holdSeconds ?? 0),
});

tasks.register({
  name: 'wazeSignIn',
  label: 'Sign in to Waze',
  description: 'Open the live map and wait while you sign in yourself. No credentials pass through here; the browser profile keeps the session.',
  enabled: () => true,
  lockGroup: BROWSER,
  run: (log, arg) => runWazeSignInPass(log, arg.holdSeconds ?? 180),
});
