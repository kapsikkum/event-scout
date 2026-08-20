import { M_PER_DEG_LAT, mPerDegLon, bboxCentre, Bbox } from './geo.js';
import type { StoredObservation } from './store.js';

export interface Grid {
  bbox: Bbox;
  cellMeters: number;
  dLat: number;
  dLon: number;
  rows: number;
  cols: number;
}

export interface Cell {
  south: number;
  north: number;
  west: number;
  east: number;
  raw: number;
  score: number;
  topName: string | null;
  breakdown: Record<string, number>;
}

export function buildGrid(bbox: Bbox, cellMeters: number): Grid {
  const { lat } = bboxCentre(bbox);
  const dLat = cellMeters / M_PER_DEG_LAT;
  const dLon = cellMeters / mPerDegLon(lat);
  return {
    bbox,
    cellMeters,
    dLat,
    dLon,
    rows: Math.max(1, Math.ceil((bbox.north - bbox.south) / dLat)),
    cols: Math.max(1, Math.ceil((bbox.east - bbox.west) / dLon)),
  };
}

export interface Accumulated {
  total: Float64Array;
  bySource: Map<string, Float64Array>;
  topLabel: Map<number, { name: string; weight: number }>;
}

/**
 * Smear every observation across the grid with a gaussian kernel and sum.
 * Sigma is a third of the radius, so the tail is effectively zero at the
 * cut-off and isolated reports don't show a hard disc edge.
 */
export function accumulate(
  grid: Grid,
  observations: StoredObservation[],
  kernelMeters: number
): Accumulated {
  const { rows, cols, bbox, dLat, dLon, cellMeters } = grid;
  const total = new Float64Array(rows * cols);
  const bySource = new Map<string, Float64Array>();
  // Remember which observation dominates each cell, so hotspots can be named.
  const topLabel = new Map<number, { name: string; weight: number }>();

  const reach = Math.max(0, Math.ceil(kernelMeters / cellMeters));
  const sigma = Math.max(kernelMeters / 3, cellMeters / 2);
  const twoSigmaSq = 2 * sigma * sigma;

  for (const obs of observations) {
    const row = Math.floor((obs.lat - bbox.south) / dLat);
    const col = Math.floor((obs.lon - bbox.west) / dLon);
    if (row < 0 || row >= rows || col < 0 || col >= cols) continue;

    if (!bySource.has(obs.source)) bySource.set(obs.source, new Float64Array(rows * cols));
    const layer = bySource.get(obs.source)!;

    for (let dr = -reach; dr <= reach; dr++) {
      const r = row + dr;
      if (r < 0 || r >= rows) continue;
      for (let dc = -reach; dc <= reach; dc++) {
        const c = col + dc;
        if (c < 0 || c >= cols) continue;
        const dist = Math.hypot(dr, dc) * cellMeters;
        if (dist > kernelMeters) continue;
        const contribution = obs.weight * Math.exp(-(dist * dist) / twoSigmaSq);
        const idx = r * cols + c;
        total[idx] += contribution;
        layer[idx] += contribution;

        const meta = obs.meta as { name?: string; street?: string } | null;
        const label = meta?.name ?? meta?.street ?? null;
        if (label && contribution > (topLabel.get(idx)?.weight ?? 0)) {
          topLabel.set(idx, { name: label, weight: contribution });
        }
      }
    }
  }
  return { total, bySource, topLabel };
}

/**
 * Normalise against a high percentile of the non-empty cells rather than the
 * maximum, so a single pile-up doesn't flatten everything else to zero.
 */
function normalise(values: Float64Array, p: number): { scale: number; normalised: Float64Array } {
  const nonZero = Array.from(values).filter((v) => v > 0).sort((a, b) => a - b);
  const idx = Math.min(nonZero.length - 1, Math.max(0, Math.round((p / 100) * (nonZero.length - 1))));
  const top = (nonZero.length ? nonZero[idx] : 0) || Math.max(...values, 1);
  return { scale: top, normalised: Float64Array.from(values, (v) => Math.min(v / top, 1)) };
}

/** Grid to cell records, dropping empties so the output stays small. */
export function toCells(
  grid: Grid,
  acc: Accumulated,
  normalisePercentile = 97
): { cells: Cell[]; scale: number } {
  const { rows, cols, bbox, dLat, dLon } = grid;
  const { scale, normalised } = normalise(acc.total, normalisePercentile);

  const cells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (acc.total[idx] <= 0) continue;
      const breakdown: Record<string, number> = {};
      for (const [source, layer] of acc.bySource) {
        if (layer[idx] > 0) breakdown[source] = Number(layer[idx].toFixed(3));
      }
      cells.push({
        south: bbox.south + r * dLat,
        north: bbox.south + (r + 1) * dLat,
        west: bbox.west + c * dLon,
        east: bbox.west + (c + 1) * dLon,
        raw: Number(acc.total[idx].toFixed(3)),
        score: Number(normalised[idx].toFixed(4)),
        topName: acc.topLabel.get(idx)?.name ?? null,
        breakdown,
      });
    }
  }
  cells.sort((a, b) => b.score - a.score);
  return { cells, scale };
}

// Perceptually-ordered sequential ramp (dark = quiet, bright = dense).
const RAMP = ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'];

export function colourFor(score: number): string {
  const t = Math.max(0, Math.min(score, 1)) * (RAMP.length - 1);
  const i = Math.min(Math.floor(t), RAMP.length - 2);
  const f = t - i;
  const hex = (s: string): number[] => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16));
  const a = hex(RAMP[i]);
  const b = hex(RAMP[i + 1]);
  return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, '0')).join('');
}
