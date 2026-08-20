// Busyness ramp, quiet -> packed. Shared by the map and the front page so a
// colour means the same thing wherever it appears.
const STOPS = ['#3b2f6b', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'];

export function busyColour(score: number): string {
  const t = Math.max(0, Math.min(score, 1)) * (STOPS.length - 1);
  const i = Math.min(Math.floor(t), STOPS.length - 2);
  const f = t - i;
  const hex = (s: string): number[] => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16));
  const a = hex(STOPS[i]);
  const b = hex(STOPS[i + 1]);
  return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, '0')).join('');
}
