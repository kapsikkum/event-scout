/**
 * Reading a start time off a page, and admitting when there isn't one.
 *
 * This is where event-scout's worst data comes from, so the crawler does it
 * deliberately rather than by handing the string to `new Date`. Measured across
 * 386 live events, 135 of them — 35% — showed an invented 11:00 am start,
 * because the page published a bare date and `new Date('2026-10-08')` is
 * defined to mean UTC midnight, which is mid-morning here.
 *
 * JavaScript parses the two shapes under opposite rules, which is the whole
 * trap:
 *
 *   '2026-10-08'           -> UTC midnight     (wrong: becomes 11am local)
 *   '2026-10-08T10:00:00'  -> local 10am       (right, if TZ is set)
 *   '2026-10-08T10:00+10'  -> absolute         (right)
 *   '2026-10-08T10:00Z'    -> absolute         (right, if the page meant UTC)
 *
 * So a bare date is built from its parts in local time and flagged, and
 * everything else is left to the parser it suits.
 */

export interface EventWhen {
  /** ISO 8601, always absolute. */
  startTime: string;
  /**
   * True when the page gave a day and no clock time.
   *
   * Carried so a reader is told "Thursday" rather than "Thursday, 11:00 am",
   * which is the difference between missing information and wrong information.
   * For a scouting app the start time is the light, so a plausible-looking lie
   * is the more expensive of the two.
   */
  dateOnly: boolean;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Any of the ways 8601 can carry an offset: a Z, or ±HH:MM / ±HHMM / ±HH. */
const HAS_OFFSET = /([zZ]|[+-]\d{2}:?\d{0,2})$/;

/**
 * The server's own zone is the assumed zone for a floating time.
 *
 * It is the best guess available — the page rarely says, and an event without a
 * zone is nearly always local to wherever it is happening, which for this app
 * is the same region the server sits in. Relying on the ambient zone rather
 * than naming one keeps it honest: docker-compose and the NixOS unit both set
 * TZ, and a container running UTC would be wrong about far more than this.
 */
export function parseWhen(raw: string): EventWhen | null {
  const text = raw.trim();
  if (!text) return null;

  const bare = DATE_ONLY.exec(text);
  if (bare) {
    const [, y, m, d] = bare;
    // Built from parts, so it is local midnight rather than UTC midnight.
    const at = new Date(Number(y), Number(m) - 1, Number(d));
    // Checked by reading the parts back, because this constructor rolls over
    // instead of refusing: month 13 day 45 is not an error, it is next
    // February. A date that silently becomes a different real date is worse
    // than one that fails, so anything that does not survive the trip is out.
    if (
      Number.isNaN(at.getTime()) ||
      at.getFullYear() !== Number(y) ||
      at.getMonth() !== Number(m) - 1 ||
      at.getDate() !== Number(d)
    ) {
      return null;
    }
    return { startTime: at.toISOString(), dateOnly: true };
  }

  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return null;

  // A datetime with no offset is read as local by the parser, which is what we
  // want; one with an offset is already absolute. Either way the clock time was
  // stated, so this is not a bare date.
  void HAS_OFFSET;
  return { startTime: at.toISOString(), dateOnly: false };
}

/**
 * Whether a start is worth keeping at all.
 *
 * event-scout validates again on its own side, so this is only about not
 * spending the frontier on pages whose events are all long past. A year ahead
 * is generous: festivals and race meetings are announced that far out.
 */
export function isWorthKeeping(startTime: string, now: Date = new Date()): boolean {
  const at = Date.parse(startTime);
  if (Number.isNaN(at)) return false;
  const dayMs = 86400000;
  return at > now.getTime() - dayMs && at < now.getTime() + 400 * dayMs;
}
