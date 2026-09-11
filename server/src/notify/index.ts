import { getKv, getSettings, setKv } from '../db.js';
import { getMergedEvents } from '../events.js';
import { runCommand, parseCommand } from './commands.js';
import { deliver, runNotifications } from './run.js';
import { dbStore, setTargetStatus, targetStatus, tidyNotifyState } from './store.js';
import { connFromSettings, IncomingMessage, knownRoomId, matrixStatus, restartMatrixBot, sendMatrix, setTyping } from './matrix.js';
import { MATRIX_LOOK_LABEL, MATRIX_LOOKS, normalizeTarget } from './targets.js';
import { matchesFilters } from './filters.js';
import { markdownToMatrix, matrixText, type BusyVenue, type MatrixContent } from './format.js';
import {
  batchQuestion, buildChatMessages, busyText, chatReply, chatStillOn, conditionsText, eventsForChat, type ChatLine,
} from './chat.js';
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

/** Rooms with an answer being worked out. */
const thinking = new Set<string>();
/**
 * Messages that arrived while the model was busy in their room. Not dropped:
 * the next turn takes all of them together, so everyone who asked is answered.
 */
const waiting = new Map<string, { lines: ChatLine[]; filters: NotifyFilters | undefined }>();
/** More than this waiting and the oldest go: a room shouting is not a queue worth working through. */
const MAX_WAITING = 8;
/** The last few turns in each chat room, oldest first. Kept in memory: a restart starts the conversation over. */
const histories = new Map<string, ChatMessage[]>();

/** Where a room's chat stands: when it was started or last answered, '' once ended. */
const chatKey = (roomId: string): string => `matrix:chat:${roomId}`;
/** On in this room, and the feature itself switched on: turning it off in Settings silences every room at once. */
const chatOn = (roomId: string): boolean =>
  getSettings().matrixBot?.chat?.enabled === true && chatStillOn(getKv(chatKey(roomId)), new Date());
const CHAT_OFF = 'Chat is switched off. It can be switched on in Settings → Notifications → Matrix bot → Chat.';

/**
 * !chat start, !chat end, and !chat on its own to ask.
 *
 * Starting is kept to the allowed accounts, because every answer is a minute
 * of someone's GPU; ending is anyone's. Either way the conversation so far is
 * forgotten, so a new chat starts clean.
 */
function chatCommand(arg: string | undefined, msg: IncomingMessage): MatrixContent {
  const settings = getSettings();
  const p = settings.matrixBot?.commandPrefix || '!';
  switch ((arg ?? '').toLowerCase()) {
    case 'start':
    case 'on': {
      if (!settings.matrixBot?.chat?.enabled) return matrixText(CHAT_OFF);
      if (!(settings.matrixBot?.allowedUsers ?? []).includes(msg.sender)) {
        return matrixText('Only accounts on the bot’s allowed list can start a chat.');
      }
      if (!(settings.matrixBot?.chat?.model || settings.llmModel)) {
        return matrixText('There is no model to chat with yet: choose one in Settings → Notifications → Chat.');
      }
      setKv(chatKey(msg.roomId), new Date().toISOString());
      histories.delete(msg.roomId);
      return matrixText(
        `Chat on. Ask me about what’s on — I’ll answer every message here until ${p}chat end, or an hour of quiet.`
      );
    }
    case 'end':
    case 'stop':
    case 'off':
      setKv(chatKey(msg.roomId), '');
      histories.delete(msg.roomId);
      return matrixText('Chat off. Commands still work.');
    default:
      if (!settings.matrixBot?.chat?.enabled) return matrixText(CHAT_OFF);
      return matrixText(chatOn(msg.roomId)
        ? `Chat is on here. ${p}chat end to stop.`
        : `Chat is off here. ${p}chat start to talk to the model about what’s on.`);
  }
}

/**
 * A message for the model in a chat room.
 *
 * Put on the room's waiting list; if nothing is being worked out there, a turn
 * starts now, and keeps going until nobody is waiting. So with several people
 * talking, whoever wrote while the model was busy is answered next, together
 * with anyone else who did — never silently skipped.
 */
function queueChat(msg: IncomingMessage, filters: NotifyFilters | undefined): void {
  const entry = waiting.get(msg.roomId) ?? { lines: [], filters };
  entry.lines.push({ sender: msg.sender, body: msg.body, eventId: msg.eventId });
  entry.lines = entry.lines.slice(-MAX_WAITING);
  entry.filters = filters;
  waiting.set(msg.roomId, entry);
  if (!thinking.has(msg.roomId)) void drainChat(msg.roomId);
}

async function drainChat(roomId: string): Promise<void> {
  thinking.add(roomId);
  try {
    for (let entry = waiting.get(roomId); entry?.lines.length; entry = waiting.get(roomId)) {
      waiting.delete(roomId);
      if (!chatOn(roomId)) return; // ended while they waited
      await answerTurn(roomId, entry.lines, entry.filters);
    }
  } finally {
    thinking.delete(roomId);
  }
}

/** One turn: the waiting messages, answered together with the local model, "typing…" meanwhile. */
async function answerTurn(roomId: string, lines: ChatLine[], filters: NotifyFilters | undefined): Promise<void> {
  const settings = getSettings();
  const chat = settings.matrixBot.chat;
  const conn = connFromSettings(settings);
  if (!conn) return;
  const model = chat.model || settings.llmModel;
  if (!model) {
    await sendMatrix(conn, roomId, matrixText('Chat is on, but no model is chosen. Pick one in Settings → Notifications.'));
    return;
  }
  const me = matrixStatus().userId;
  try {
    await setTyping(conn, roomId, me, true).catch(() => undefined);
    const now = new Date();
    const question = batchQuestion(lines);
    const history = histories.get(roomId) ?? [];
    const conditions = await getPhotoConditions().then(conditionsText).catch(() => '');
    const messages = buildChatMessages({
      settings,
      events: eventsForChat(getMergedEvents(), lines.map((l) => l.body).join('\n'), filters, now),
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
    await sendMatrix(conn, roomId, chatReply(answer, lines));
    // Still talking: the hour of quiet that ends a chat starts again from here.
    if (chatOn(roomId)) setKv(chatKey(roomId), new Date().toISOString());
    const kept = Math.max(0, chat.historyMessages);
    histories.set(roomId, kept ? [...history, { role: 'user' as const, content: question }, { role: 'assistant' as const, content: answer }].slice(-kept) : []);
  } catch (err) {
    await sendMatrix(conn, roomId, chatReply(`I couldn’t answer that: ${(err as Error).message}`, lines)).catch(() => undefined);
  } finally {
    await setTyping(conn, roomId, me, false).catch(() => undefined);
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
    // Not a command: answered by the model while a chat is on in the room,
    // in the background so the sync loop is not held up for the minute a
    // model can take. The room's target, if it has one, narrows the events.
    if (chatOn(msg.roomId)) queueChat(msg, target?.filters);
    return null;
  }
  if (cmd.name === 'chat') return chatCommand(cmd.args[0], msg);
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
