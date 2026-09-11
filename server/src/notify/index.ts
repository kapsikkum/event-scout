import { getKv, getSettings } from '../db.js';
import { getMergedEvents, setGroupFlag } from '../events.js';
import { runCommand, parseCommand } from './commands.js';
import { deliver, runNotifications } from './run.js';
import { dbStore, setTargetStatus, targetStatus, tidyNotifyState } from './store.js';
import { IncomingMessage, matrixStatus, restartMatrixBot } from './matrix.js';
import { normalizeTarget } from './targets.js';
import { matchesFilters } from './filters.js';
import type { MatrixContent } from './format.js';
import type { TaskLog, TaskResult } from '../tasks/registry.js';

/**
 * The notifications, wired to the database and the event list.
 *
 * Everything in the modules beside this one is handed its events, settings and
 * clock; this is the one place that fetches them, so the rest stays testable.
 */

/** The task body: one pass over every target. */
export async function notifyTask(log: TaskLog): Promise<TaskResult> {
  const settings = getSettings();
  const targets = (settings.notifyTargets ?? []).filter((t) => t.enabled);
  if (!targets.length) return { ok: true, message: 'no targets switched on' };
  const result = await runNotifications({ settings, events: getMergedEvents(), store: dbStore });
  const at = new Date().toISOString();
  for (const [id, s] of Object.entries(result.statuses)) setTargetStatus(id, { at, ...s });
  for (const line of result.lines) log(line);
  const tidied = tidyNotifyState();
  if (tidied) log(`forgot ${tidied} old sent-markers`);
  if (result.failed) return { ok: false, message: `${result.failed} target${result.failed === 1 ? '' : 's'} failed` };
  return { ok: true, message: result.sent ? `sent ${result.sent} message${result.sent === 1 ? '' : 's'}` : 'nothing to send' };
}

/** A sample to one saved target, with a few real events so the layout can be judged. */
export async function sendTest(id: string): Promise<{ ok: boolean; message: string }> {
  const settings = getSettings();
  const raw = (settings.notifyTargets ?? []).find((t) => t.id === id);
  if (!raw) return { ok: false, message: 'Save the target first; there is no saved target with that id.' };
  const target = normalizeTarget(raw);
  const events = getMergedEvents()
    .filter((ev) => !ev.hidden && !ev.culled && matchesFilters(ev, target.filters, { ignoreStarredOnly: true }))
    .slice(0, 3);
  try {
    await deliver(target, {
      kind: 'test',
      heading: events.length
        ? `🔔 A test from Event Scout. The next ${events.length} event${events.length === 1 ? '' : 's'} this target would show:`
        : '🔔 A test from Event Scout. Nothing upcoming matches this target’s filters right now.',
      items: events.map((ev) => ({ ev })),
    }, settings);
    setTargetStatus(id, { at: new Date().toISOString(), ok: true, message: 'test sent' });
    return { ok: true, message: 'Sent.' };
  } catch (err) {
    setTargetStatus(id, { at: new Date().toISOString(), ok: false, message: (err as Error).message });
    return { ok: false, message: (err as Error).message };
  }
}

export function notifyStatus(): {
  matrix: ReturnType<typeof matrixStatus>;
  targets: Record<string, ReturnType<typeof targetStatus>>;
} {
  const targets: Record<string, ReturnType<typeof targetStatus>> = {};
  for (const t of getSettings().notifyTargets ?? []) targets[t.id] = targetStatus(t.id);
  return { matrix: matrixStatus(), targets };
}

/** The bot's answer to one message in one of its rooms, or nothing if it was not a command. */
function handleMatrixMessage(msg: IncomingMessage): MatrixContent | null {
  const settings = getSettings();
  const prefix = settings.matrixBot?.commandPrefix || '!';
  const cmd = parseCommand(msg.body, prefix);
  if (!cmd) return null;
  return runCommand(cmd, msg, {
    events: () => getMergedEvents(),
    setFlag: setGroupFlag,
    allowed: (sender) => (getSettings().matrixBot?.allowedUsers ?? []).includes(sender),
    appUrl: settings.appUrl ?? '',
    prefix,
    status: () => {
      const last = getKv('lastRefresh');
      const shown = getMergedEvents().filter((e) => !e.hidden && !e.culled);
      return `${shown.length} upcoming events, ${shown.filter((e) => e.starred).length} shortlisted. ` +
        `Last looked ${last ? new Date(last).toLocaleString('en-AU') : 'never'}.`;
    },
  });
}

/** Start the Matrix bot, or restart it after a settings change. */
export function startMatrix(): void {
  restartMatrixBot(handleMatrixMessage);
}
