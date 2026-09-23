/**
 * Reading a start time off a listing, and which starts are believed at all.
 * See README.md in this directory.
 *
 * The worst data this app ever had came from one line: `new Date(startDate)`.
 * Handed a bare date, JavaScript is defined to read it as UTC midnight, which
 * is mid-morning in Australia — so of 386 live listings, 135 showed an
 * invented 11:00 am start. For a scouting app the start is the light, and a
 * plausible wrong hour is worse than none. The two shapes parse under opposite
 * rules, which is the trap:
 *
 *   '2026-10-08'           UTC midnight   (wrong: 11am here)
 *   '2026-10-08T10:00:00'  local 10am     (right, TZ being set)
 *   '2026-10-08T10:00+11'  absolute       (right)
 *
 * So a bare date is built from its parts in local time and flagged, and
 * everything else is left to the parser it suits. The local zone is the
 * server's own, which docker-compose and the NixOS unit both set.
 */

export interface EventWhen {
  /** ISO 8601, always absolute. */
  startTime: string;
  /**
   * The listing gave a day and no clock time. Carried so a reader is told
   * "Thursday" rather than "Thursday, 11:00 am": missing, not wrong.
   */
  dateOnly: boolean;
}

const DAY_MS = 86400_000;

/**
 * How far into the past a start may sit and still be believed. A day and a
 * half covers events already running and clock skew. Anything older is a stale
 * schema.org block on a recurring event's page: a weekly market's page carried
 * a year-old startDate all through the next year.
 */
export const PAST_GRACE_MS = 36 * 3600_000;

/** Starts further out than this are almost always a mis-parsed year. */
export const FUTURE_HORIZON_MS = 400 * DAY_MS;

/**
 * Longest run believed for one listing. Festivals last weeks; an end fourteen
 * months after the start is a page reusing one block for a season.
 */
export const MAX_DURATION_MS = 21 * DAY_MS;

/** Whether a start falls inside the window above. */
export function isWorthKeeping(startTime: string, now: Date = new Date()): boolean {
  const at = Date.parse(startTime);
  if (Number.isNaN(at)) return false;
  return at >= now.getTime() - PAST_GRACE_MS && at <= now.getTime() + FUTURE_HORIZON_MS;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function rawDateString(val: unknown): string | undefined {
  if (typeof val === 'string') {
    const s = val.trim();
    return s || undefined;
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    const s = rawDateString(obj.startDate);
    if (s) return s;
    const d = rawDateString(obj.doorTime);
    if (d) return d;
  }
  return undefined;
}

export function parseWhen(startRaw?: unknown, endRaw?: unknown): EventWhen | null {
  const text = rawDateString(startRaw) ?? rawDateString(endRaw);
  if (!text) return null;

  const bare = DATE_ONLY.exec(text);
  if (bare) {
    const [y, m, d] = [Number(bare[1]), Number(bare[2]), Number(bare[3])];
    const at = new Date(y, m - 1, d);
    // Read back, because this constructor rolls over rather than refusing:
    // month 13 day 45 is next February, and a garbage string silently becoming
    // a real day is worse than it failing.
    if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== d) return null;
    return { startTime: at.toISOString(), dateOnly: true };
  }

  // Normalize space-separated timestamps: e.g. "2026-10-15 19:30:00" -> "2026-10-15T19:30:00"
  let normalized = text.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/, '$1T$2');

  // Normalize timezone offsets without colons: "+1100" -> "+11:00", "-0500" -> "-05:00"
  normalized = normalized.replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*([+-]\d{2})(\d{2})$/, '$1$2:$3');

  // Also clean up loose space before coloned offset or Z
  normalized = normalized.replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s+([+-]\d{2}:\d{2}|Z)$/i, '$1$2');

  const at = new Date(normalized);
  if (Number.isNaN(at.getTime())) return null;
  return { startTime: at.toISOString(), dateOnly: false };
}

/**
 * An end, where a bare date means the close of that day rather than its first
 * minute — a festival "ending" on the 9th runs through the 9th.
 */
export function parseEnd(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const when = parseWhen(raw);
  if (!when) return undefined;
  if (!when.dateOnly) return when.startTime;
  const at = new Date(when.startTime);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).toISOString();
}
