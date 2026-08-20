import { getSettings } from '../db.js';
import { Area, densityConfig, pickAreas, resolveAreas } from './areas.js';
import { insertObservations, insertRun, selectObservations, venueCount, loadVenues, Observation } from './store.js';
import { scrapePopular, discoverVenues } from './sources/googlePopular.js';
import { scrapeWaze, WazeResult } from './sources/waze.js';
import { scrapeWazeViaBrowser, signInToWaze } from './sources/wazeBrowser.js';
import { accumulate, buildGrid, colourFor, toCells } from './grid.js';

/**
 * The scrape and render pipeline.
 *
 * Called by the background scheduler and by the manual buttons; there is no CLI.
 * Rendering happens on demand from stored observations rather than writing files
 * to disk, so the map always reflects the latest pass without a build step.
 */

export interface AreaResult {
  area: string;
  name: string;
  ok: boolean;
  observations?: number;
  bySource?: Record<string, number>;
  error?: string;
}

/**
 * One Waze pass.
 *
 * The direct fetch is tried first because it costs one request and would be the
 * cheaper answer if it ever started working; when it is refused — which is the
 * normal outcome — the browser transport can open the live map so the page makes
 * the requests itself. See `sources/waze.ts` for why it works that way.
 *
 * The browser half runs only when a person asked for it. reCAPTCHA Enterprise
 * scores behaviour, and an unattended window scores like what it is, so running
 * it on the hourly timer would pop a window on the desktop every hour and
 * collect nothing. The button exists precisely so the window has someone at it.
 */
async function scrapeWazePass(
  area: Area, cfg: ReturnType<typeof densityConfig>, log: (msg: string) => void,
  opts: { useBrowser: boolean; holdMs?: number } = { useBrowser: false }
): Promise<WazeResult> {
  const direct = await scrapeWaze(area, { cookie: process.env.WAZE_COOKIE ?? '' }, log);
  if (direct.observations.length > 0) return direct;
  if (!opts.useBrowser) {
    log('  waze: refused without a browser - use "Collect Waze reports" under Settings');
    return direct;
  }

  log('  waze: opening the live map in a browser');
  const viaBrowser = await scrapeWazeViaBrowser(
    area,
    {
      browserPath: cfg.browserPath,
      headless: cfg.wazeHeadless,
      profileDir: cfg.wazeProfileDir,
      holdMs: opts.holdMs ?? cfg.wazeHoldMs,
      cookie: cfg.wazeCookie,
    },
    log
  );
  log(
    `  waze: ${viaBrowser.summary.jams} jam(s), ${viaBrowser.summary.alerts} alert(s), ` +
    `${viaBrowser.summary.users} wazer(s)`
  );
  return viaBrowser;
}

/** Open the live map so the user can sign in; the profile keeps the session. */
export async function runWazeSignIn(
  holdSeconds: number, log: (msg: string) => void = () => {}
): Promise<{ signedIn: boolean; message: string }> {
  const cfg = densityConfig();
  return signInToWaze(
    {
      browserPath: cfg.browserPath,
      profileDir: cfg.wazeProfileDir,
      cookie: cfg.wazeCookie,
      holdMs: Math.max(30, holdSeconds) * 1000,
    },
    log
  );
}

/** A Waze-only pass, for the button that opens the map so it can be driven. */
export async function runWaze(
  areaNames: string[] | undefined, holdSeconds: number, log: (msg: string) => void = () => {}
): Promise<AreaResult[]> {
  const cfg = densityConfig();
  const results: AreaResult[] = [];
  for (const area of pickAreas(areaNames)) {
    log(`${area.name}:`);
    try {
      const res = await scrapeWazePass(area, cfg, log, { useBrowser: true, holdMs: holdSeconds * 1000 });
      const ts = Math.floor(Date.now() / 1000);
      const runId = insertRun({
        ts, area: area.slug, bbox: area.bbox,
        summary: { waze: res.summary }, durationMs: 0,
      });
      insertObservations(runId, ts, area.slug, res.observations);
      results.push({
        area: area.slug, name: area.name, ok: !res.summary.blocked,
        observations: res.observations.length,
        error: res.summary.blocked ?? undefined,
      });
    } catch (err) {
      log(`  ${area.name} failed: ${(err as Error).message}`);
      results.push({ area: area.slug, name: area.name, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

/** Scrape every enabled source for one area and store the result. */
export async function scrapeArea(area: Area, log: (msg: string) => void = () => {}): Promise<AreaResult> {
  const started = Date.now();
  const ts = Math.floor(started / 1000);
  const settings = getSettings();
  const cfg = densityConfig(settings);
  const observations: Observation[] = [];
  const summary: Record<string, unknown> = {};

  if (settings.densityWaze) {
    const res = await scrapeWazePass(area, cfg, log);
    observations.push(...res.observations);
    summary.waze = res.summary;
  }

  const popular = await scrapePopular(area, cfg, log);
  observations.push(...popular.observations);
  summary.googlePopular = popular.summary;

  const durationMs = Date.now() - started;
  const runId = insertRun({ ts, area: area.slug, bbox: area.bbox, summary, durationMs });
  insertObservations(runId, ts, area.slug, observations);

  const bySource: Record<string, number> = {};
  for (const o of observations) bySource[o.source] = (bySource[o.source] ?? 0) + 1;

  log(`  stored ${observations.length} observations in ${(durationMs / 1000).toFixed(1)}s`);
  return { area: area.slug, name: area.name, ok: true, observations: observations.length, bySource };
}

/** Scrape the selected areas, or all configured ones. */
export async function runScrape(
  areaNames?: string[], log: (msg: string) => void = () => {}
): Promise<{ ok: boolean; areas: AreaResult[] }> {
  const areas = pickAreas(areaNames);
  if (areas.length === 0) return { ok: false, areas: [] };

  const results: AreaResult[] = [];
  for (const area of areas) {
    log(`${area.name}:`);
    try {
      results.push(await scrapeArea(area, log));
    } catch (err) {
      log(`  ${area.name} failed: ${(err as Error).message}`);
      results.push({ area: area.slug, name: area.name, ok: false, error: (err as Error).message });
    }
  }
  return { ok: results.some((r) => r.ok), areas: results };
}

/** Rebuild venue lists for the selected areas. */
export async function runDiscover(
  areaNames?: string[], log: (msg: string) => void = () => {}
): Promise<AreaResult[]> {
  const cfg = densityConfig();
  const results: AreaResult[] = [];
  for (const area of pickAreas(areaNames)) {
    log(`${area.name}:`);
    try {
      const res = await discoverVenues(area, cfg, log);
      results.push({ area: area.slug, name: area.name, ok: true, observations: res.venues });
    } catch (err) {
      log(`  ${area.name} failed: ${(err as Error).message}`);
      results.push({ area: area.slug, name: area.name, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

export interface RenderOpts {
  hours?: number;
  all?: boolean;
  hourOfDay?: number;
  daysOfWeek?: number[];
  sources?: string[];
}

/**
 * Build the density grid for an area, as GeoJSON. Computed on demand — the
 * grid is small enough that caching it would cost more than it saves.
 */
export function renderArea(area: Area, opts: RenderOpts = {}): unknown | null {
  const hours = opts.hours ?? 24;
  const rows = selectObservations({
    area: area.slug,
    sinceTs: opts.all ? undefined : Math.floor(Date.now() / 1000) - hours * 3600,
    hourOfDay: opts.hourOfDay,
    daysOfWeek: opts.daysOfWeek,
    sources: opts.sources,
  });
  if (rows.length === 0) return null;

  const grid = buildGrid(area.bbox, area.cellMeters);
  const acc = accumulate(grid, rows, area.kernelMeters);
  const { cells, scale } = toCells(grid, acc);
  const snapshots = new Set(rows.map((r) => r.ts)).size;

  return {
    type: 'FeatureCollection',
    metadata: {
      label: [
        opts.all ? 'all history' : `last ${hours}h`,
        opts.hourOfDay != null ? `hour ${String(opts.hourOfDay).padStart(2, '0')}:00` : null,
        `${snapshots} snapshot${snapshots === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' - '),
      area: area.name,
      bbox: area.bbox,
      observations: rows.length,
      snapshots,
      normaliseScale: Number(scale.toFixed(4)),
      generatedAt: new Date().toISOString(),
    },
    features: cells.map((c) => ({
      type: 'Feature',
      properties: {
        score: c.score, raw: c.raw, topName: c.topName,
        breakdown: c.breakdown, colour: colourFor(c.score),
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [c.west, c.south], [c.east, c.south],
          [c.east, c.north], [c.west, c.north], [c.west, c.south],
        ]],
      },
    })),
  };
}

export interface VenueReading {
  name: string;
  lat: number;
  lon: number;
  live: number | null;
  typical: number | null;
  score: number;
  observedAt: string | null;
  busiestDay: string | null;
  busiestHour: number | null;
  quietestDay: string | null;
  openDays: string[] | null;
}

/**
 * Each venue with its most recent reading. Newest wins rather than an average,
 * since "how busy is it right now" is the question the map answers. The weekly
 * profile is joined on from the venue record.
 */
export function venueReadings(area: Area): VenueReading[] {
  const venues = loadVenues(area.slug);
  const rows = selectObservations({ area: area.slug, sources: ['google-popular'] })
    .sort((a, b) => b.ts - a.ts);

  const latest = new Map<string, { live: number | null; typical: number | null; weight: number; ts: number }>();
  for (const r of rows) {
    const meta = r.meta as { name?: string; live?: number | null; typical?: number | null } | null;
    if (!meta?.name || latest.has(meta.name)) continue;
    latest.set(meta.name, {
      live: meta.live ?? null, typical: meta.typical ?? null, weight: r.weight, ts: r.ts,
    });
  }

  return venues.map((v) => {
    const reading = latest.get(v.name);
    return {
      name: v.name,
      lat: v.lat,
      lon: v.lon,
      live: reading?.live ?? null,
      typical: reading?.typical ?? null,
      score: reading?.weight ?? 0,
      observedAt: reading ? new Date(reading.ts * 1000).toISOString() : null,
      busiestDay: v.profile?.busiestDay ?? null,
      busiestHour: v.profile?.busiestHour ?? null,
      quietestDay: v.profile?.quietestDay ?? null,
      openDays: v.profile?.openDays ?? null,
    };
  }).sort((a, b) => b.score - a.score);
}

export interface HistoryPoint {
  ts: number;
  live: number | null;
  typical: number | null;
}

export interface VenueHistory {
  name: string;
  lat: number;
  lon: number;
  points: HistoryPoint[];
  /** Google's own weekly profile, as the reference curve. */
  byDay: Record<string, Record<string, number>> | null;
  busiestDay: string | null;
  busiestHour: number | null;
  /** Observed average per hour-of-day, across the requested window. */
  observedByHour: Record<number, { avg: number; samples: number }>;
}

/**
 * Everything recorded for one venue over the last `days`.
 *
 * Two different things are returned deliberately: `points` is what we actually
 * measured, and `byDay` is Google's typical profile. Comparing them is the
 * whole point — "busier than usual" is the interesting signal, not the raw
 * percentage.
 */
export function venueHistory(area: Area, venueName: string, days = 14): VenueHistory | null {
  const venue = loadVenues(area.slug).find((v) => v.name === venueName);
  if (!venue) return null;

  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = selectObservations({ area: area.slug, sinceTs: since, sources: ['google-popular'] })
    .filter((r) => (r.meta as { name?: string } | null)?.name === venueName)
    .sort((a, b) => a.ts - b.ts);

  const points: HistoryPoint[] = rows.map((r) => {
    const meta = r.meta as { live?: number | null; typical?: number | null } | null;
    return { ts: r.ts, live: meta?.live ?? null, typical: meta?.typical ?? null };
  });

  // Average what we actually observed, bucketed by hour of day.
  const buckets = new Map<number, number[]>();
  for (const p of points) {
    const value = p.live ?? p.typical;
    if (value == null) continue;
    const hour = new Date(p.ts * 1000).getHours();
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour)!.push(value);
  }
  const observedByHour: Record<number, { avg: number; samples: number }> = {};
  for (const [hour, values] of buckets) {
    observedByHour[hour] = {
      avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
      samples: values.length,
    };
  }

  return {
    name: venue.name,
    lat: venue.lat,
    lon: venue.lon,
    points,
    byDay: venue.profile?.byDay ?? null,
    busiestDay: venue.profile?.busiestDay ?? null,
    busiestHour: venue.profile?.busiestHour ?? null,
    observedByHour,
  };
}

export interface AreaSummary {
  slug: string;
  name: string;
  venues: number;
  withProfile: number;
}

export function listAreas(): AreaSummary[] {
  return resolveAreas().map((a) => {
    const venues = loadVenues(a.slug);
    return {
      slug: a.slug,
      name: a.name,
      venues: venueCount(a.slug),
      withProfile: venues.filter((v) => v.profile).length,
    };
  });
}

export interface WazeReport {
  kind: string;
  type: string | null;
  lat: number;
  lon: number;
  street: string | null;
  description: string | null;
  reportedAt: string | null;
  observedAt: string;
  /** Jam-only: how much time it is costing, and how long the queue is. */
  delaySec?: number | null;
  lengthM?: number | null;
}

export interface WazeSnapshot {
  observedAt: string | null;
  reports: WazeReport[];
  wazers: { lat: number; lon: number; stationary: boolean }[];
}

/**
 * The most recent Waze pass for an area: hazards, police, crashes, closures and
 * jams, plus wazer positions.
 *
 * Only the newest pass is returned rather than everything inside a window. An
 * alert that has been cleared simply stops appearing in later passes, so
 * merging passes together would keep showing police who left an hour ago.
 */
export function wazeSnapshot(area: Area, maxAgeHours = 3): WazeSnapshot {
  const since = Math.floor(Date.now() / 1000) - maxAgeHours * 3600;
  const rows = selectObservations({
    area: area.slug,
    sinceTs: since,
    sources: ['waze-alert', 'waze-jam', 'waze-users'],
  });
  if (rows.length === 0) return { observedAt: null, reports: [], wazers: [] };

  const newest = Math.max(...rows.map((r) => r.ts));
  const latest = rows.filter((r) => r.ts === newest);

  const reports: WazeReport[] = [];
  const wazers: { lat: number; lon: number; stationary: boolean }[] = [];
  // A jam is stored as one observation per sampled point along its line; the
  // map wants one marker per jam, so the first point of each stands for it.
  const seenJams = new Set<string>();

  for (const row of latest) {
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    if (row.source === 'waze-users') {
      wazers.push({ lat: row.lat, lon: row.lon, stationary: row.kind === 'stationary' });
      continue;
    }
    if (row.source === 'waze-jam') {
      const key = `${meta.street ?? ''}|${meta.lengthM ?? ''}|${meta.delaySec ?? ''}`;
      if (seenJams.has(key)) continue;
      seenJams.add(key);
    }
    reports.push({
      kind: row.source === 'waze-jam' ? 'JAM' : String(row.kind ?? 'UNKNOWN'),
      type: (meta.type as string) ?? (row.source === 'waze-jam' ? 'JAM' : null),
      lat: row.lat,
      lon: row.lon,
      street: (meta.street as string) ?? null,
      description: (meta.description as string) ?? null,
      reportedAt: (meta.reportedAt as string) ?? null,
      observedAt: new Date(row.ts * 1000).toISOString(),
      delaySec: (meta.delaySec as number) ?? null,
      lengthM: (meta.lengthM as number) ?? null,
    });
  }

  return { observedAt: new Date(newest * 1000).toISOString(), reports, wazers };
}
