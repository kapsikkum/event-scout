import { getKv, getSettings, saveSettings, setKv } from '../db.js';
import { archivePastEvents, getProgress, refreshAll } from '../refresh.js';
import { runDensityScrape, runVenueDiscovery } from '../densityRefresh.js';
import { pruneObservations } from '../density/store.js';
import { runFlyerFetch, tidyFlyers } from '../flyerStore.js';
import { runEnrichment } from '../enrich/pipeline.js';
import { runVisionPass } from '../enrich/visionPipeline.js';
import { createRegistry } from './registry.js';
import { notifyTask } from '../notify/index.js';

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
    // Density samples are pruned here rather than in the density task, so they
    // are tidied even while sampling is switched off — which is exactly when
    // nothing else would be looking at that table.
    const stale = pruneObservations();
    if (stale.observations > 0) log(`pruned ${stale.observations} density observations`);
    // Same beat as the events themselves: a flyer is re-filed when its event
    // moves, and dropped once the event is past and was never shortlisted.
    const flyers = tidyFlyers();
    if (flyers.refiled > 0) log(`re-filed ${flyers.refiled} flyers`);
    if (flyers.removed > 0) log(`removed ${flyers.removed} flyers`);
    return {
      ok: true,
      message:
        archived === 0 && purged === 0 && stale.observations === 0
          ? 'nothing to archive'
          : `archived ${archived}${purged > 0 ? `, purged ${purged}` : ''}` +
            (stale.observations > 0 ? `, pruned ${stale.observations} samples` : ''),
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
  name: 'enrich',
  label: 'Read listings with a local model',
  description: 'Ask a local Ollama to tidy descriptions, categorise, fill in blank venue and price fields, and judge photo appeal. Everything it says is stored beside the scraped values, never over them.',
  // Same arrangement as density: a frequent tick over a slower interval, so the
  // interval can be changed without a restart.
  schedule: '*/5 * * * *',
  intervalMinutes: () => Math.max(5, getSettings().llmIntervalMinutes ?? 60),
  enabled: () => Boolean(getSettings().llmEnabled),
  setEnabled: (on) => saveSettings({ ...getSettings(), llmEnabled: on }),
  run: (log) => runEnrichment(log),
});

tasks.register({
  name: 'vision',
  label: 'Read event flyers',
  description: 'Ask a vision model to read the venue, address and price printed on each event flyer, filling only the fields the listing left blank.',
  schedule: '*/5 * * * *',
  intervalMinutes: () => Math.max(5, getSettings().visionIntervalMinutes ?? 60),
  enabled: () => Boolean(getSettings().visionEnabled),
  setEnabled: (on) => saveSettings({ ...getSettings(), visionEnabled: on }),
  run: (log) => runVisionPass(log),
});

tasks.register({
  name: 'flyers',
  label: 'Keep a copy of the flyers',
  description:
    'Download the picture from each upcoming or shortlisted event and keep it, filed by the date of the event. Makes re-reading a flyer free, and keeps the card working when the original address stops answering.',
  schedule: '*/20 * * * *',
  intervalMinutes: () => 20,
  enabled: () => !paused('flyers'),
  setEnabled: (on) => setPaused('flyers', !on),
  run: (log) => runFlyerFetch(log),
});

tasks.register({
  name: 'notify',
  label: 'Send notifications',
  description:
    'Tell the Discord webhooks and Matrix rooms set up in Settings about new events, the digest, reminders before shortlisted events, and changes to them.',
  schedule: '*/5 * * * *',
  intervalMinutes: () => 5,
  enabled: () => !paused('notify'),
  setEnabled: (on) => setPaused('notify', !on),
  run: (log) => notifyTask(log),
});

tasks.register({
  name: 'densityDiscover',
  label: 'Rebuild venue list',
  description: 'Re-run venue discovery for every area. Slow, and rarely needed: which venues exist changes far less than how busy they are.',
  enabled: () => true,
  lockGroup: BROWSER,
  run: (log) => runVenueDiscovery(log),
});
