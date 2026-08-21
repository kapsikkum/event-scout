import { SunDay } from '../photo.js';

/**
 * How good a place is to point a camera at, given how busy it is.
 *
 * Busyness is not "more is better". A dead venue has nothing in it to shoot;
 * a packed one has crowded frames, queues, no parking and nowhere to stand
 * back from a subject. The sweet spot is in between -- enough going on to be
 * worth the drive, still room to work -- so the curve rises to a peak around
 * two-thirds full and falls away on both sides.
 *
 * Which way that cuts does depend on the subject: an empty laneway is a gift
 * if you are shooting architecture. This scores for the kind of shooting the
 * app is for -- car and bike meets, markets, events -- where the people and
 * the vehicles are the subject, so an empty venue really is a wasted trip.
 */

export type Light = 'golden' | 'day' | 'blue' | 'night';

export interface ShootVerdict {
  /** 0..1, comparable across venues and hours. */
  score: number;
  label: 'Prime' | 'Good' | 'Fair' | 'Quiet' | 'Dead' | 'Unknown';
  /** Short human reason, for a tooltip or a subtitle. */
  why: string;
  light?: Light;
  /** True when measured busyness is well above this venue's normal. */
  surge?: boolean;
  /**
   * True when the score came from Google's typical curve because nothing live
   * was published. Worth saying out loud: it is a prediction, not a reading.
   */
  estimated?: boolean;
}

/**
 * Control points for the crowd curve, busy% -> desirability.
 *
 * Piecewise-linear rather than a formula because the shape is a judgement
 * about photography, not a natural law, and the points are easier to argue
 * with than coefficients would be.
 */
const CURVE: [number, number][] = [
  [0, 0.06],
  [10, 0.22],
  [25, 0.48],
  [40, 0.72],
  [55, 0.92],
  [68, 1.0],
  [80, 0.88],
  [90, 0.7],
  [100, 0.48],
];

export function crowdScore(busyPct: number): number {
  const p = Math.max(0, Math.min(100, busyPct));
  for (let i = 1; i < CURVE.length; i++) {
    const [x0, y0] = CURVE[i - 1];
    const [x1, y1] = CURVE[i];
    if (p <= x1) return y0 + ((y1 - y0) * (p - x0)) / (x1 - x0);
  }
  return CURVE[CURVE.length - 1][1];
}

/**
 * Light multiplier.
 *
 * Golden hour is worth going out of your way for, so it lifts an otherwise
 * ordinary hour above a busier one in flat midday sun. Night is not zero --
 * lit car meets photograph well -- but it is hard enough to be a real penalty.
 */
export function lightFactor(light?: Light): number {
  switch (light) {
    case 'golden': return 1.15;
    case 'blue': return 0.95;
    case 'night': return 0.5;
    case 'day': return 1;
    default: return 1;
  }
}

const LIGHT_NOTE: Record<Light, string> = {
  golden: 'golden hour',
  blue: 'blue hour',
  day: 'daylight',
  night: 'after dark',
};

function crowdNote(p: number): string {
  if (p < 10) return 'empty';
  if (p < 25) return 'very quiet';
  if (p < 45) return 'a few people about';
  if (p < 70) return 'busy enough for subjects, room to move';
  if (p < 88) return 'crowded but workable';
  return 'packed — crowded frames, parking full';
}

function label(score: number): ShootVerdict['label'] {
  if (score >= 0.85) return 'Prime';
  if (score >= 0.65) return 'Good';
  if (score >= 0.42) return 'Fair';
  if (score >= 0.2) return 'Quiet';
  return 'Dead';
}

export interface ShootInput {
  /** Measured busyness now, 0-100. */
  busy: number | null;
  /** What this venue is normally like at this hour, 0-100. */
  typical?: number | null;
  light?: Light;
  /** Set when `busy` is the typical figure standing in for a missing reading. */
  estimated?: boolean;
}

export function shootScore({ busy, typical, light, estimated }: ShootInput): ShootVerdict {
  if (busy == null) {
    return { score: 0, label: 'Unknown', why: 'no reading', light };
  }

  let score = crowdScore(busy) * lightFactor(light);

  // Busier than its own normal is the strongest signal there is: it means
  // something is on that nobody published. Deliberately a modifier and not
  // the whole score -- twice as busy as normal is still not worth the drive
  // if normal is two people.
  const surge = typical != null && typical >= 5 && busy >= typical * 1.4 && busy - typical >= 12;
  if (surge) score += 0.12;
  const dead = typical != null && typical >= 25 && busy <= typical * 0.5;
  if (dead) score -= 0.08;

  score = Math.max(0, Math.min(1, score));

  const parts = [estimated ? `${crowdNote(busy)}, going by a normal week` : crowdNote(busy)];
  if (surge) parts.push(`busier than usual for the time (${typical}% typical)`);
  else if (dead) parts.push(`quieter than usual (${typical}% typical)`);
  if (light) parts.push(LIGHT_NOTE[light]);

  return { score, label: label(score), why: parts.join(' · '), light, surge, estimated };
}

/**
 * The best stretch of hours to shoot on a given day.
 *
 * Returns a contiguous window rather than a single hour because a photographer
 * plans a trip, not a minute, and a lone peak hour surrounded by near-equal
 * ones is a false precision. Hours within a whisker of the best are absorbed
 * into the window.
 */
export function bestWindow(
  hours: Record<string, number>,
  lightAt?: (hour: number) => Light
): { from: number; to: number; score: number; label: ShootVerdict['label'] } | null {
  const scored = Object.entries(hours)
    .map(([h, pct]) => ({
      hour: Number(h),
      score: shootScore({ busy: pct, light: lightAt?.(Number(h)) }).score,
    }))
    .sort((a, b) => a.hour - b.hour);
  if (scored.length === 0) return null;

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score <= 0.2) return null;

  const near = best.score - 0.08;
  const byHour = new Map(scored.map((s) => [s.hour, s.score]));
  let from = best.hour;
  let to = best.hour;
  while ((byHour.get(from - 1) ?? -1) >= near) from--;
  while ((byHour.get(to + 1) ?? -1) >= near) to++;

  return { from, to, score: best.score, label: label(best.score) };
}

/**
 * Which light band an hour falls in, from that day's sun times at the venue.
 *
 * Classified at the middle of the hour: an hour that straddles two bands is
 * called by whichever it spends most of itself in, which is the same answer a
 * person would give.
 */
export function lightBands(sun: SunDay): (hour: number) => Light {
  const at = (iso: string | null): number | null =>
    iso ? new Date(iso).getHours() + new Date(iso).getMinutes() / 60 : null;
  const win = (w: { start: string; end: string } | null): [number, number] | null => {
    const a = at(w?.start ?? null);
    const b = at(w?.end ?? null);
    return a != null && b != null ? [a, b] : null;
  };

  const golden = [win(sun.goldenMorning), win(sun.goldenEvening)].filter(Boolean) as [number, number][];
  const blue = [win(sun.blueMorning), win(sun.blueEvening)].filter(Boolean) as [number, number][];
  const sunrise = at(sun.sunrise);
  const sunset = at(sun.sunset);

  return (hour: number): Light => {
    const t = hour + 0.5;
    const inside = (r: [number, number]): boolean => t >= r[0] && t <= r[1];
    if (golden.some(inside)) return 'golden';
    if (blue.some(inside)) return 'blue';
    if (sunrise != null && sunset != null) return t >= sunrise && t <= sunset ? 'day' : 'night';
    return 'day';
  };
}
