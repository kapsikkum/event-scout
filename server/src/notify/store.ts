import { db, getKv, setKv } from '../db.js';

/**
 * What the notifications remember between runs.
 *
 * Which reminders and changes each target has already been sent, so a run
 * every five minutes never repeats itself, and what each starred event looked
 * like when a target last saw it, so a change can be told from nothing. Its
 * own tables, created here, so nothing else needs to know they exist.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS notify_sent (
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (target_id, kind, ref)
);
CREATE TABLE IF NOT EXISTS notify_snapshot (
  target_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (target_id, ref)
);
`);

export interface Snapshot {
  title: string;
  startTime: string;
  endTime: string;
  venue: string;
  address: string;
}

/** The state a run reads and writes. An interface, so the runner can be tested with a Map. */
export interface NotifyStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  wasSent(target: string, kind: string, ref: string): boolean;
  markSent(target: string, kind: string, ref: string): void;
  snapshot(target: string, ref: string): Snapshot | null;
  setSnapshot(target: string, ref: string, snap: Snapshot): void;
}

export const dbStore: NotifyStore = {
  get: getKv,
  set: setKv,
  wasSent: (target, kind, ref) =>
    Boolean(db.prepare('SELECT 1 FROM notify_sent WHERE target_id = ? AND kind = ? AND ref = ?').get(target, kind, ref)),
  markSent: (target, kind, ref) => {
    db.prepare('INSERT OR IGNORE INTO notify_sent (target_id, kind, ref, sent_at) VALUES (?, ?, ?, ?)')
      .run(target, kind, ref, new Date().toISOString());
  },
  snapshot: (target, ref) => {
    const row = db.prepare('SELECT data FROM notify_snapshot WHERE target_id = ? AND ref = ?').get(target, ref) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Snapshot) : null;
  },
  setSnapshot: (target, ref, snap) => {
    db.prepare(
      `INSERT INTO notify_snapshot (target_id, ref, data) VALUES (?, ?, ?)
       ON CONFLICT(target_id, ref) DO UPDATE SET data = excluded.data`
    ).run(target, ref, JSON.stringify(snap));
  },
};

/** Drop what is too old to matter: a reminder for last month's event will not be sent again anyway. */
export function tidyNotifyState(days = 60): number {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return Number(db.prepare('DELETE FROM notify_sent WHERE sent_at < ?').run(cutoff).changes);
}

export interface TargetStatus {
  at: string;
  ok: boolean;
  message: string;
}

export function targetStatus(id: string): TargetStatus | null {
  const raw = getKv(`notify:status:${id}`);
  return raw ? (JSON.parse(raw) as TargetStatus) : null;
}

export function setTargetStatus(id: string, s: TargetStatus): void {
  setKv(`notify:status:${id}`, JSON.stringify(s));
}
