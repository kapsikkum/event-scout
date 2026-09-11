import { getSettings } from '../db.js';
import type { MatrixContent } from './format.js';

/**
 * A Matrix bot, on the client-server API and nothing else.
 *
 * No SDK: sending is one PUT, and listening is a /sync long-poll in a loop,
 * which is the whole of what a bot that answers commands needs. It posts the
 * notifications the targets ask for, joins rooms it is invited to by someone on
 * the allowed list, and hands every message in its rooms to a command handler.
 *
 * Unencrypted rooms only. Reading an encrypted room means carrying the whole
 * of Olm/Megolm, which is not worth it for a bot that lists events.
 *
 * The homeserver is allowed to be on the local network — that is where a
 * self-hosted one usually is — since it is set by whoever holds the password,
 * not by a listing.
 */

export class MatrixError extends Error {}

export interface MatrixConn {
  homeserver: string;
  token: string;
}

export function connFromSettings(settings = getSettings()): MatrixConn | null {
  const homeserver = (settings.matrixBot?.homeserver ?? '').trim().replace(/\/+$/, '');
  const token = (settings.matrixAccessToken ?? '').trim();
  return /^https?:\/\/\S+$/i.test(homeserver) && token ? { homeserver, token } : null;
}

async function call<T>(
  conn: MatrixConn, method: string, path: string, body?: unknown, signal: AbortSignal = AbortSignal.timeout(20000)
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${conn.homeserver}${path}`, {
      method,
      headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new MatrixError(`cannot reach ${conn.homeserver}: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: string; errcode?: string };
      detail = parsed.error ?? parsed.errcode ?? detail;
    } catch {
      /* keep the raw text */
    }
    throw new MatrixError(`${res.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const rooms = new Map<string, string>();

/** A room id for an id or an alias, looked up once. */
export async function resolveRoom(conn: MatrixConn, room: string): Promise<string> {
  const trimmed = room.trim();
  if (trimmed.startsWith('!')) return trimmed;
  const known = rooms.get(trimmed);
  if (known) return known;
  if (!trimmed.startsWith('#')) throw new MatrixError(`"${trimmed}" is not a room id (!…) or alias (#…)`);
  const found = await call<{ room_id: string }>(conn, 'GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(trimmed)}`);
  rooms.set(trimmed, found.room_id);
  return found.room_id;
}

export async function joinRoom(conn: MatrixConn, room: string): Promise<string> {
  const joined = await call<{ room_id: string }>(conn, 'POST', `/_matrix/client/v3/join/${encodeURIComponent(room.trim())}`, {});
  if (room.trim().startsWith('#')) rooms.set(room.trim(), joined.room_id);
  return joined.room_id;
}

let txn = 0;
export async function sendMatrix(conn: MatrixConn, room: string, content: MatrixContent): Promise<void> {
  const id = await resolveRoom(conn, room);
  await call(conn, 'PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/send/m.room.message/es${Date.now()}-${txn++}`, content);
}

// --- the bot ---------------------------------------------------------------------

export interface IncomingMessage {
  roomId: string;
  sender: string;
  body: string;
}

export type CommandHandler = (msg: IncomingMessage) => Promise<MatrixContent | null> | MatrixContent | null;

export interface BotStatus {
  state: 'off' | 'starting' | 'running' | 'error';
  userId: string;
  /** Rooms it is in, as of the first sync and the joins since. */
  rooms: number;
  lastError: string;
  lastSyncAt: string | null;
}

interface SyncEvent {
  type: string;
  sender: string;
  state_key?: string;
  content?: { body?: unknown; membership?: string };
}
interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: SyncEvent[] } }>;
    invite?: Record<string, { invite_state?: { events?: SyncEvent[] } }>;
  };
}

/** Only messages and memberships, and not much history of either. */
const FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: { limit: 20, types: ['m.room.message'] },
    state: { types: ['m.room.member'], lazy_load_members: true },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
});

let status: BotStatus = { state: 'off', userId: '', rooms: 0, lastError: '', lastSyncAt: null };
let generation = 0;
let stopCurrent: AbortController | null = null;

export const matrixStatus = (): BotStatus => ({ ...status });

/** A wait that ends early when the bot is stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Stop the bot if it is running and start it again from Settings.
 *
 * Called at startup and on every settings save, so a changed token or
 * homeserver takes effect at once. Each start has its own generation, and a
 * loop that finds it is no longer the current one ends itself.
 */
export function restartMatrixBot(handler: CommandHandler): void {
  generation++;
  stopCurrent?.abort();
  stopCurrent = null;
  const settings = getSettings();
  const conn = connFromSettings(settings);
  if (!settings.matrixBot?.enabled || !conn) {
    status = { state: 'off', userId: '', rooms: 0, lastError: settings.matrixBot?.enabled ? 'No homeserver or access token set' : '', lastSyncAt: null };
    return;
  }
  const ctl = new AbortController();
  stopCurrent = ctl;
  void loop(generation, conn, handler, ctl.signal);
}

async function loop(gen: number, conn: MatrixConn, handler: CommandHandler, stop: AbortSignal): Promise<void> {
  status = { state: 'starting', userId: '', rooms: 0, lastError: '', lastSyncAt: null };
  let since: string | null = null;
  let me = '';
  let backoff = 5000;
  const live = (): boolean => gen === generation && !stop.aborted;
  const allowed = (user: string): boolean => (getSettings().matrixBot?.allowedUsers ?? []).includes(user);

  while (live()) {
    try {
      if (!me) {
        me = (await call<{ user_id: string }>(conn, 'GET', '/_matrix/client/v3/account/whoami')).user_id;
        status.userId = me;
        // The rooms the targets post to, joined up front where the room allows
        // it, so posting there does not wait for an invite.
        for (const t of getSettings().notifyTargets ?? []) {
          if (t.kind !== 'matrix' || !t.enabled || !t.roomId) continue;
          try {
            await joinRoom(conn, t.roomId);
          } catch {
            // Invite-only: an invite from an allowed user will get it in.
          }
        }
      }

      const params = new URLSearchParams({ filter: FILTER, timeout: since ? '30000' : '0' });
      if (since) params.set('since', since);
      const sync: SyncResponse = await call<SyncResponse>(
        conn, 'GET', `/_matrix/client/v3/sync?${params}`, undefined, AbortSignal.any([stop, AbortSignal.timeout(50000)])
      );
      if (!live()) return;
      const first = since === null;
      since = sync.next_batch;
      if (first) status.rooms = Object.keys(sync.rooms?.join ?? {}).length;
      status = { ...status, state: 'running', lastSyncAt: new Date().toISOString(), lastError: '' };
      backoff = 5000;

      for (const [roomId, room] of Object.entries(sync.rooms?.invite ?? {})) {
        const invite = room.invite_state?.events?.find((e) => e.type === 'm.room.member' && e.state_key === me);
        if (!invite || !allowed(invite.sender)) continue;
        try {
          await joinRoom(conn, roomId);
          status.rooms++;
        } catch (err) {
          status.lastError = `could not join ${roomId}: ${(err as Error).message}`;
        }
      }

      // What was said before the bot started was not said to it.
      if (first) continue;
      for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
        for (const ev of room.timeline?.events ?? []) {
          if (ev.type !== 'm.room.message' || ev.sender === me || typeof ev.content?.body !== 'string') continue;
          try {
            const reply = await handler({ roomId, sender: ev.sender, body: ev.content.body });
            if (reply && live()) await sendMatrix(conn, roomId, reply);
          } catch (err) {
            status.lastError = `answering in ${roomId}: ${(err as Error).message}`;
          }
        }
      }
    } catch (err) {
      if (!live()) return;
      status = { ...status, state: 'error', lastError: (err as Error).message };
      // A bad token will not get better by asking again every five seconds.
      if (/M_UNKNOWN_TOKEN|401/.test((err as Error).message)) backoff = 300000;
      await pause(backoff, stop);
      backoff = Math.min(backoff * 2, 300000);
    }
  }
}
