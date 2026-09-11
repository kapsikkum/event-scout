import crypto from 'node:crypto';
import type { NotifyFilters, NotifyTarget, NotifyTriggers } from '../sources/types.js';

/**
 * A notification target, whole and within bounds, whatever was stored.
 *
 * Settings arrive from a form and from older saves that predate a field, so
 * every field is filled and every number clamped here, once, rather than
 * defended against at each place a target is read.
 */

/** The ways a Matrix room can lay events out, in the order Settings offers them. */
export const MATRIX_LOOKS = ['cards', 'minimal', 'table', 'plain'] as const;
export const MATRIX_LOOK_LABEL: Record<(typeof MATRIX_LOOKS)[number], string> = {
  cards: 'cards', minimal: 'minimal lines', table: 'table', plain: 'plain text',
};

export const DEFAULT_TRIGGERS: NotifyTriggers = {
  newEvents: { enabled: true, settleMinutes: 30, maxPerRun: 10 },
  digest: { enabled: false, cadence: 'weekly', weekday: 4, hour: 18, daysAhead: 7 },
  reminders: { enabled: false, hoursBefore: [24, 2] },
  starredChanges: { enabled: false },
  busy: { enabled: false, threshold: 80, venues: [], cooldownHours: 6 },
};

export const DEFAULT_FILTERS: NotifyFilters = {
  places: [],
  categories: [],
  excludeCategories: [],
  minPhotoScore: 0,
  keywords: [],
  excludeKeywords: [],
  starredOnly: false,
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const list = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100) : [];

export const newTargetId = (): string => crypto.randomUUID().slice(0, 8);

export function normalizeTarget(raw: unknown): NotifyTarget {
  const t = obj(raw);
  const tr = obj(t.triggers);
  const ne = obj(tr.newEvents);
  const dg = obj(tr.digest);
  const rm = obj(tr.reminders);
  const sc = obj(tr.starredChanges);
  const bz = obj(tr.busy);
  const f = obj(t.filters);
  const q = obj(t.quietHours);
  const d = DEFAULT_TRIGGERS;
  const hours = (Array.isArray(rm.hoursBefore) ? rm.hoursBefore : d.reminders.hoursBefore)
    .map((h) => num(h, -1, 0, 24 * 14))
    .filter((h) => h >= 0);
  return {
    id: str(t.id, 40) || newTargetId(),
    kind: t.kind === 'matrix' ? 'matrix' : 'discord',
    name: str(t.name, 80),
    enabled: bool(t.enabled, true),
    webhookUrl: str(t.webhookUrl, 500),
    username: str(t.username, 80),
    avatarUrl: str(t.avatarUrl, 500),
    mention: /^(@here|@everyone|@room|\d{5,25})$/.test(str(t.mention, 40)) ? str(t.mention, 40) : '',
    style: t.style === 'compact' ? 'compact' : 'full',
    showImage: bool(t.showImage, true),
    roomId: str(t.roomId, 255),
    // Ordinary messages unless asked otherwise: clients draw notices greyed out.
    matrixLoud: bool(t.matrixLoud, true),
    commands: bool(t.commands, true),
    matrixLook: (MATRIX_LOOKS as readonly string[]).includes(String(t.matrixLook))
      ? (t.matrixLook as NotifyTarget['matrixLook'])
      : 'minimal',
    triggers: {
      newEvents: {
        enabled: bool(ne.enabled, d.newEvents.enabled),
        settleMinutes: num(ne.settleMinutes, d.newEvents.settleMinutes, 0, 24 * 60),
        maxPerRun: num(ne.maxPerRun, d.newEvents.maxPerRun, 1, 50),
      },
      digest: {
        enabled: bool(dg.enabled, d.digest.enabled),
        cadence: dg.cadence === 'daily' ? 'daily' : 'weekly',
        weekday: num(dg.weekday, d.digest.weekday, 0, 6),
        hour: num(dg.hour, d.digest.hour, 0, 23),
        daysAhead: num(dg.daysAhead, d.digest.daysAhead, 1, 60),
      },
      reminders: { enabled: bool(rm.enabled, d.reminders.enabled), hoursBefore: [...new Set(hours)].sort((a, b) => b - a) },
      starredChanges: { enabled: bool(sc.enabled, d.starredChanges.enabled) },
      busy: {
        enabled: bool(bz.enabled, d.busy.enabled),
        threshold: num(bz.threshold, d.busy.threshold, 10, 100),
        venues: list(bz.venues),
        cooldownHours: num(bz.cooldownHours, d.busy.cooldownHours, 1, 72),
      },
    },
    filters: {
      places: list(f.places),
      categories: list(f.categories),
      excludeCategories: list(f.excludeCategories),
      minPhotoScore: num(f.minPhotoScore, 0, 0, 100),
      keywords: list(f.keywords),
      excludeKeywords: list(f.excludeKeywords),
      starredOnly: bool(f.starredOnly, false),
    },
    quietHours: { enabled: bool(q.enabled, false), from: num(q.from, 22, 0, 23), to: num(q.to, 7, 0, 23) },
  };
}
