import type { MergedEvent } from '../events.js';
import type { NotifyTarget, Settings } from '../sources/types.js';
import { matchesFilters } from './filters.js';
import { BusyVenue, Change, discordPayloads, matrixMessages, Notice, NoticeItem, whenText } from './format.js';
import { sendDiscord } from './discord.js';
import { connFromSettings, imagesFor, sendMatrix } from './matrix.js';
import { NotifyStore, Snapshot } from './store.js';
import { normalizeTarget } from './targets.js';
import { isOver } from '../validate.js';

/**
 * Deciding what each target is told, and telling it.
 *
 * Four triggers, each keeping its own place so a run every five minutes never
 * repeats itself and a missed run loses nothing:
 *
 *   - New events: everything first found after the target's watermark and
 *     long enough ago to have settled — placed on the map, read by the model,
 *     culled or not — which is why it waits. The watermark then moves up to
 *     that point. A target's first run only sets it, so switching one on does
 *     not post the whole backlog.
 *   - Digest: once per slot, a list of what is coming up.
 *   - Reminders: a starred event, some hours before it starts, once per offset.
 *   - Changes: a starred event whose time, place or name moved since this target
 *     last saw it.
 *
 * The events and the clock come in as arguments, so all of it can be tested.
 */

/** An event's identity across refreshes: its oldest listing, which survives re-grouping. */
export const evKey = (ev: MergedEvent): string => String(Math.min(...ev.members.map((m) => m.id)));

const visible = (ev: MergedEvent): boolean => !ev.hidden && !ev.culled;

/** A repeating event once, with how many more dates it has among these. */
export function foldSeries(events: MergedEvent[]): NoticeItem[] {
  const out: NoticeItem[] = [];
  const bySeries = new Map<string, NoticeItem>();
  for (const ev of events) {
    const seen = ev.series ? bySeries.get(ev.series) : undefined;
    if (seen) {
      seen.moreDates = (seen.moreDates ?? 0) + 1;
      continue;
    }
    const item: NoticeItem = { ev };
    if (ev.series) bySeries.set(ev.series, item);
    out.push(item);
  }
  return out;
}

export function inQuietHours(q: NotifyTarget['quietHours'], now: Date): boolean {
  if (!q.enabled || q.from === q.to) return false;
  const h = now.getHours();
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

/** The latest digest slot at or before now. */
export function digestSlot(d: NotifyTarget['triggers']['digest'], now: Date): Date {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), d.hour, 0, 0, 0);
  if (d.cadence === 'daily') {
    if (at > now) at.setDate(at.getDate() - 1);
    return at;
  }
  at.setDate(at.getDate() - ((at.getDay() - d.weekday + 7) % 7));
  if (at > now) at.setDate(at.getDate() - 7);
  return at;
}

const snapOf = (ev: MergedEvent): Snapshot => ({
  title: ev.title,
  startTime: ev.startTime,
  endTime: ev.endTime ?? '',
  venue: ev.venueName,
  address: ev.address,
});

export function diffSnapshot(before: Snapshot, ev: MergedEvent): Change[] {
  const after = snapOf(ev);
  const changes: Change[] = [];
  if (before.title !== after.title) changes.push({ field: 'title', before: before.title, after: after.title });
  if (before.startTime !== after.startTime) {
    changes.push({ field: 'start', before: whenText(before.startTime, false), after: whenText(after.startTime, ev.dateOnly) });
  }
  if (before.endTime !== after.endTime && after.endTime) {
    changes.push({ field: 'end', before: before.endTime ? whenText(before.endTime, false) : '', after: whenText(after.endTime, false) });
  }
  if (before.venue !== after.venue) changes.push({ field: 'venue', before: before.venue, after: after.venue });
  else if (before.address !== after.address) changes.push({ field: 'address', before: before.address, after: after.address });
  return changes;
}

/** What one target should be sent now. Writes the target's state as it goes. */
/** A density reading older than this is not "right now". Sampling runs hourly by default. */
const BUSY_FRESH_MS = 90 * 60_000;

export function planTarget(
  target: NotifyTarget, events: MergedEvent[], store: NotifyStore, now: Date, venues: BusyVenue[] = []
): Notice[] {
  const notices: Notice[] = [];
  const shown = events.filter(visible);
  const t = target.triggers;
  const id = target.id;

  if (t.newEvents.enabled) {
    const key = `notify:new:${id}`;
    const settled = new Date(now.getTime() - t.newEvents.settleMinutes * 60_000).toISOString();
    const since = store.get(key);
    if (since === null) {
      store.set(key, settled);
    } else if (settled > since) {
      const fresh = shown
        .filter((ev) => ev.firstSeenAt && ev.firstSeenAt > since && ev.firstSeenAt <= settled)
        .filter((ev) => matchesFilters(ev, target.filters))
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      const items = foldSeries(fresh);
      if (items.length) {
        const kept = items.slice(0, t.newEvents.maxPerRun);
        notices.push({
          kind: 'new',
          heading: `✦ ${items.length} new event${items.length === 1 ? '' : 's'} found`,
          items: kept,
          more: items.length - kept.length,
        });
      }
      store.set(key, settled);
    }
  }

  if (t.digest.enabled) {
    const key = `notify:digest:${id}`;
    const slot = digestSlot(t.digest, now).toISOString();
    const last = store.get(key);
    if (last === null) {
      store.set(key, slot);
    } else if (slot > last) {
      const until = now.getTime() + t.digest.daysAhead * 86400_000;
      const coming = shown
        .filter((ev) => !isOver(ev.startTime, ev.endTime, now) && Date.parse(ev.startTime) <= until)
        .filter((ev) => matchesFilters(ev, target.filters));
      const items = foldSeries(coming);
      const kept = items.slice(0, 40);
      notices.push({
        kind: 'digest',
        heading: `📅 Coming up in the next ${t.digest.daysAhead} day${t.digest.daysAhead === 1 ? '' : 's'}: ${items.length} event${items.length === 1 ? '' : 's'}`,
        items: kept,
        more: items.length - kept.length,
      });
      store.set(key, slot);
    }
  }

  const starred = shown.filter((ev) => ev.starred && matchesFilters(ev, target.filters, { ignoreStarredOnly: true }));

  if (t.reminders.enabled && t.reminders.hoursBefore.length) {
    const due: NoticeItem[] = [];
    for (const ev of starred) {
      const start = Date.parse(ev.startTime);
      if (start <= now.getTime()) continue;
      // Every offset that has come round, marked at once, so a star added an
      // hour before the start gets one reminder rather than a burst of them.
      const passed = t.reminders.hoursBefore.filter((h) => now.getTime() >= start - h * 3600_000);
      const unsent = passed.filter((h) => !store.wasSent(id, 'reminder', `${evKey(ev)}@${ev.startTime}#${h}`));
      if (!unsent.length) continue;
      for (const h of passed) store.markSent(id, 'reminder', `${evKey(ev)}@${ev.startTime}#${h}`);
      due.push({ ev });
    }
    if (due.length) {
      notices.push({
        kind: 'reminder',
        heading: due.length === 1 ? `⏰ Coming up: ${due[0].ev.title}` : `⏰ ${due.length} shortlisted events coming up`,
        items: due,
      });
    }
  }

  if (t.starredChanges.enabled) {
    const changed: NoticeItem[] = [];
    for (const ev of starred) {
      const ref = evKey(ev);
      const before = store.snapshot(id, ref);
      store.setSnapshot(id, ref, snapOf(ev));
      if (!before) continue;
      const changes = diffSnapshot(before, ev);
      if (changes.length) changed.push({ ev, changes });
    }
    if (changed.length) {
      notices.push({
        kind: 'change',
        heading: changed.length === 1 ? `✎ Changed: ${changed[0].ev.title}` : `✎ ${changed.length} shortlisted events changed`,
        items: changed,
      });
    }
  }
  if (t.busy.enabled && venues.length) {
    const picked = t.busy.venues.map((v) => v.toLowerCase());
    const due = venues.filter((v) => {
      if (v.live == null || v.live < t.busy.threshold || !v.observedAt) return false;
      if (now.getTime() - Date.parse(v.observedAt) > BUSY_FRESH_MS) return false;
      if (picked.length && !picked.includes(v.name.toLowerCase())) return false;
      // Once per place per cooldown: a place that stays packed all evening is one message, not twelve.
      const last = store.get(`notify:busy:${id}:${v.area}|${v.name}`);
      return !last || now.getTime() - Date.parse(last) >= t.busy.cooldownHours * 3600_000;
    }).sort((a, b) => (b.live ?? 0) - (a.live ?? 0));
    if (due.length) {
      for (const v of due) store.set(`notify:busy:${id}:${v.area}|${v.name}`, now.toISOString());
      notices.push({
        kind: 'busy',
        heading: due.length === 1 ? `🔥 ${due[0].name} is busy right now` : `🔥 ${due.length} places are busy right now`,
        items: [],
        venues: due,
      });
    }
  }
  return notices;
}

export type Deliver = (target: NotifyTarget, notice: Notice, settings: Settings) => Promise<void>;

/** Send one notice to one target, over whichever service it is. */
export const deliver: Deliver = async (target, notice, settings) => {
  if (target.kind === 'discord') {
    await sendDiscord(target.webhookUrl, discordPayloads(notice, target, settings.appUrl ?? ''));
    return;
  }
  const conn = connFromSettings(settings);
  if (!conn) throw new Error('The Matrix bot has no homeserver or access token in Settings');
  if (!target.roomId) throw new Error('No room set for this target');
  const pictures = target.showImage && (target.matrixLook === 'cards' || target.matrixLook === 'minimal') && notice.kind !== 'digest'
    ? await imagesFor(conn, notice.items.map((i) => i.ev.imageUrl))
    : {};
  for (const content of matrixMessages(notice, target, settings.appUrl ?? '', pictures)) {
    await sendMatrix(conn, target.roomId, content);
  }
};

export interface RunResult {
  sent: number;
  failed: number;
  lines: string[];
  statuses: Record<string, { ok: boolean; message: string }>;
}

/**
 * One pass over every enabled target.
 *
 * A target in its quiet hours is skipped whole, state and all, so what it would
 * have been told waits for the hours to end rather than being lost.
 */
export async function runNotifications(opts: {
  settings: Settings;
  events: MergedEvent[];
  store: NotifyStore;
  now?: Date;
  send?: Deliver;
  /** The latest density readings, for the busy-place trigger. */
  venues?: BusyVenue[];
}): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const send = opts.send ?? deliver;
  const result: RunResult = { sent: 0, failed: 0, lines: [], statuses: {} };
  for (const raw of opts.settings.notifyTargets ?? []) {
    const target = normalizeTarget(raw);
    if (!target.enabled) continue;
    const label = target.name || `${target.kind} ${target.id}`;
    if (inQuietHours(target.quietHours, now)) {
      result.lines.push(`${label}: quiet hours`);
      continue;
    }
    const notices = planTarget(target, opts.events, opts.store, now, opts.venues ?? []);
    if (!notices.length) continue;
    try {
      for (const notice of notices) {
        await send(target, notice, opts.settings);
        result.sent++;
      }
      const message = notices.map((n) => n.kind).join(', ');
      result.lines.push(`${label}: sent ${message}`);
      result.statuses[target.id] = { ok: true, message: `sent ${message}` };
    } catch (err) {
      result.failed++;
      result.lines.push(`${label}: ${(err as Error).message}`);
      result.statuses[target.id] = { ok: false, message: (err as Error).message };
    }
  }
  return result;
}
