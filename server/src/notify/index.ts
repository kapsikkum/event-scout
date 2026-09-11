import { getKv, getSettings } from '../db.js';
import { getMergedEvents } from '../events.js';
import { runCommand, parseCommand } from './commands.js';
import { deliver, runNotifications } from './run.js';
import { dbStore, setTargetStatus, targetStatus, tidyNotifyState } from './store.js';
import { connFromSettings, IncomingMessage, knownRoomId, matrixStatus, restartMatrixBot, sendMatrix, setTyping } from './matrix.js';
import { MATRIX_LOOK_LABEL, MATRIX_LOOKS, normalizeTarget } from './targets.js';
import { matchesFilters } from './filters.js';
import { markdownToMatrix, matrixText, type BusyVenue, type MatrixContent } from './format.js';
import { buildChatMessages, busyText, conditionsText, eventsForChat, speaker } from './chat.js';
import { resolveAreas } from '../density/areas.js';
import { venueReadings } from '../density/pipeline.js';
import { chatText, type ChatMessage } from '../enrich/ollama.js';
import { ollamaUrl } from '../enrich/pipeline.js';
import { getPhotoConditions } from '../photo.js';
import type { NotifyFilters } from '../sources/types.js';
import type { TaskLog, TaskResult } from '../tasks/registry.js';

/**
 * The notifications, wired to the database and the event list.
 *
 * Everything in the modules beside this one is handed its events, settings and
 * clock; this is the one place that fetches them, so the rest stays testable.
 */

/**
 * Every sampled place with its latest reading, across the density areas.
 *
 * Read from what density sampling has stored; nothing is sampled here. An area
 * whose readings will not load is left out rather than failing the caller.
 */
export function busyVenues(): BusyVenue[] {
  const out: BusyVenue[] = [];
  for (const area of resolveAreas()) {
    try {
      for (const v of venueReadings(area)) {
        out.push({ name: v.name, area: area.name, live: v.live, typical: v.typical, observedAt: v.observedAt });
      }
    } catch {
      // No venues discovered yet for this area.
    }
  }
  return out;
}

/** The task body: one pass over every target. */
export async function notifyTask(log: TaskLog): Promise<TaskResult> {
  const settings = getSettings();
  const targets = (settings.notifyTargets ?? []).filter((t) => t.enabled);
  if (!targets.length) return { ok: true, message: 'no targets switched on' };
  const wantsBusy = targets.some((t) => normalizeTarget(t).triggers.busy.enabled);
  const result = await runNotifications({
    settings, events: getMergedEvents(), store: dbStore, venues: wantsBusy ? busyVenues() : [],
  });
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

/**
 * One sample per Matrix look to a saved room, with real events, so the looks
 * can be compared in the client the room is actually read in.
 */
export async function sendLooks(id: string): Promise<{ ok: boolean; message: string }> {
  const settings = getSettings();
  const raw = (settings.notifyTargets ?? []).find((t) => t.id === id);
  if (!raw) return { ok: false, message: 'Save the target first; there is no saved target with that id.' };
  const target = normalizeTarget(raw);
  if (target.kind !== 'matrix') return { ok: false, message: 'Looks are for Matrix rooms.' };
  const events = getMergedEvents()
    .filter((ev) => !ev.hidden && !ev.culled && matchesFilters(ev, target.filters, { ignoreStarredOnly: true }))
    .slice(0, 3);
  try {
    for (const [i, look] of MATRIX_LOOKS.entries()) {
      await deliver(
        { ...target, matrixLook: look },
        {
          kind: 'test',
          heading: `🎨 Look ${i + 1} of ${MATRIX_LOOKS.length}: ${MATRIX_LOOK_LABEL[look]}`,
          items: events.map((ev) => ({ ev })),
        },
        settings
      );
    }
    return { ok: true, message: `Sent ${MATRIX_LOOKS.length} samples. Pick one under Look.` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** Rooms with an answer being worked out, so a burst of messages is one answer, not five. */
const thinking = new Set<string>();
/** The last few turns in each chat room, oldest first. Kept in memory: a restart starts the conversation over. */
const histories = new Map<string, ChatMessage[]>();

/** Answer a message in a chat room with the local model, showing "typing…" meanwhile. */
async function answerChat(msg: IncomingMessage, filters: NotifyFilters): Promise<void> {
  const settings = getSettings();
  const chat = settings.matrixBot.chat;
  const conn = connFromSettings(settings);
  if (!conn || thinking.has(msg.roomId)) return;
  const model = chat.model || settings.llmModel;
  if (!model) {
    await sendMatrix(conn, msg.roomId, matrixText('Chat is on, but no model is chosen. Pick one in Settings → Notifications.'));
    return;
  }
  thinking.add(msg.roomId);
  const me = matrixStatus().userId;
  try {
    await setTyping(conn, msg.roomId, me, true).catch(() => undefined);
    const now = new Date();
    const question = `${speaker(msg.sender)}: ${msg.body.slice(0, 2000)}`;
    const history = histories.get(msg.roomId) ?? [];
    const conditions = await getPhotoConditions().then(conditionsText).catch(() => '');
    const messages = buildChatMessages({
      settings,
      events: eventsForChat(getMergedEvents(), msg.body, filters, now),
      // qwen3 ignores Ollama's think switch on some versions and reasons out
      // loud for a minute; its own soft switch is this, on the turn itself.
      // Not kept in the history, which stays what was actually said.
      question: /qwen3/i.test(model) ? `${question} /no_think` : question,
      history,
      now,
      conditions,
      busy: busyText(busyVenues(), now),
    });
    const answer = await chatText({ url: ollamaUrl(settings.llmUrl), model, messages, timeoutMs: 180000, numCtx: 8192 });
    await sendMatrix(conn, msg.roomId, markdownToMatrix(answer));
    const kept = Math.max(0, chat.historyMessages);
    histories.set(msg.roomId, kept ? [...history, { role: 'user' as const, content: question }, { role: 'assistant' as const, content: answer }].slice(-kept) : []);
  } catch (err) {
    await sendMatrix(conn, msg.roomId, matrixText(`I couldn’t answer that: ${(err as Error).message}`)).catch(() => undefined);
  } finally {
    thinking.delete(msg.roomId);
    await setTyping(conn, msg.roomId, me, false).catch(() => undefined);
  }
}

/** The bot's answer to one message in one of its rooms, or nothing if it was not a command. */
function handleMatrixMessage(msg: IncomingMessage): MatrixContent | null {
  const settings = getSettings();
  const prefix = settings.matrixBot?.commandPrefix || '!';
  const cmd = parseCommand(msg.body, prefix);
  // The room's own target decides whether commands are answered there and
  // what they may list; a room with none follows the bot-wide switch.
  const target = (settings.notifyTargets ?? [])
    .map(normalizeTarget)
    .find((t) => t.kind === 'matrix' && t.roomId && knownRoomId(t.roomId) === msg.roomId);
  if (!cmd) {
    // Not a command: a chat room answers it, in the background so the sync
    // loop is not held up for the minute a model can take.
    if (target?.chat && settings.matrixBot?.chat?.enabled) void answerChat(msg, target.filters);
    return null;
  }
  if (target ? !target.commands : settings.matrixBot?.commandsEverywhere === false) return null;
  return runCommand(cmd, msg, {
    filters: target?.filters,
    events: () => getMergedEvents(),
    venues: busyVenues,
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
