/**
 * Reading a start time off a listing, and admitting when there isn't one.
 *
 * The worst data in this database came from one line: `new Date(startDate)`.
 * Handed a bare date, JavaScript is defined to read it as UTC midnight, which
 * is mid-morning in Australia — so of 386 live listings, 135 showed an
 * invented 11:00 am start. For a scouting app the start is the light, and a
 * plausible wrong hour is worse than none.
 *
 * The two shapes are parsed under opposite rules, which is the trap:
 *
 *   '2026-10-08'           UTC midnight   (wrong: 11am here)
 *   '2026-10-08T10:00:00'  local 10am     (right, TZ being set)
 *   '2026-10-08T10:00+11'  absolute       (right)
 *
 * So a bare date is built from its parts in local time and flagged, and
 * everything else is left to the parser it suits.
 *
 * The crawler has its own copy in crawler/src/extract/when.ts. They are
 * separate programs with no shared code, so a fix to one belongs in both.
 */

export interface EventWhen {
  /** ISO 8601, always absolute. */
  startTime: string;
  /** The listing gave a day and no clock time. */
  dateOnly: boolean;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight on a bare date, or null if the date does not exist. */
function localMidnight(text: string): Date | null {
  const bare = DATE_ONLY.exec(text);
  if (!bare) return null;
  const [y, m, d] = [Number(bare[1]), Number(bare[2]), Number(bare[3])];
  const at = new Date(y, m - 1, d);
  // Read back, because this constructor rolls over rather than refusing:
  // month 13 day 45 is next February, and a garbage string silently becoming
  // a real day is worse than it failing.
  if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== d) return null;
  return at;
}

export function parseWhen(raw: string): EventWhen | null {
  const text = raw.trim();
  if (!text) return null;
  if (DATE_ONLY.test(text)) {
    const at = localMidnight(text);
    return at ? { startTime: at.toISOString(), dateOnly: true } : null;
  }
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return null;
  return { startTime: at.toISOString(), dateOnly: false };
}

/**
 * An end, where a bare date means the close of that day rather than its first
 * minute — otherwise a festival "ending" on the 9th would be over as the 9th
 * began.
 */
export function parseEnd(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  const bare = localMidnight(text);
  if (bare) return new Date(bare.getFullYear(), bare.getMonth(), bare.getDate() + 1).toISOString();
  if (DATE_ONLY.test(text)) return undefined;
  return parseWhen(text)?.startTime;
}
