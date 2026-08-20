import { resolve } from 'node:path';
import { getSettings } from '../db.js';
import { bboxFromRadius, Bbox } from './geo.js';
import type { Settings } from '../sources/types.js';

/**
 * Areas to map, resolved from event-scout's own settings so the location is
 * configured once. Each area is either a radius around a point or an explicit
 * bbox; the configured city is used when no areas are listed at all.
 */

export interface Area {
  name: string;
  slug: string;
  bbox: Bbox;
  cellMeters: number;
  kernelMeters: number;
}

export interface DensityArea {
  name: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  bbox?: Bbox;
  cellMeters?: number;
  kernelMeters?: number;
}

export const DEFAULT_SEARCHES = [
  'cafe', 'pub', 'restaurant', 'park', 'car park', 'shopping centre',
  'hotel', 'lookout', 'sports ground', 'supermarket',
  // Motorsport venues are the point in a town like Bathurst, and no generic
  // term surfaces them: "racetrack" is what finds Mount Panorama.
  'racetrack', 'motor racing',
];

/** Everything the sources need, with defaults applied. */
export interface DensityConfig {
  searches: string[];
  places: string[];
  placesPerName: number;
  maxVenues: number;
  searchZoom: number;
  requestDelayMs: number;
  waitMs: number;
  headless: boolean;
  browserPath: string | null;
  profileDir: string;
  /**
   * Waze gets its own profile. Two browsers cannot share a profile directory —
   * the lock on it is exclusive — and a Waze login has no business sitting in
   * the profile used to read Google Maps.
   */
  wazeProfileDir: string;
  wazeHeadless: boolean;
  wazeHoldMs: number;
  wazeCookie: string;
  weight: number;
}

export function slugify(name: string): string {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'area';
}

export function densityConfig(settings: Settings = getSettings()): DensityConfig {
  return {
    searches: settings.densitySearches?.length ? settings.densitySearches : DEFAULT_SEARCHES,
    places: settings.densityPlaces ?? [],
    placesPerName: 2,
    // 0 means keep everything discovery found. The cap only ever existed to
    // bound how long a pass takes, so there is no reason it cannot be lifted.
    maxVenues: (settings.densityMaxVenues ?? 30) > 0
      ? Math.max(1, settings.densityMaxVenues)
      : Number.POSITIVE_INFINITY,
    searchZoom: 14,
    // Mean pause between venue page loads; the caller jitters around it, so
    // this is the average cadence rather than a fixed interval.
    requestDelayMs: 2000,
    waitMs: 7000,
    headless: true,
    browserPath: settings.densityBrowserPath || null,
    // Persistent, and it matters: a browser arriving with no cookies at all on
    // every run gets served Google's stripped-down "limited view", which omits
    // popular times entirely. This profile is ours alone.
    profileDir: resolve(process.cwd(), 'data', 'browser-profile'),
    wazeProfileDir: resolve(process.cwd(), 'data', 'waze-profile'),
    wazeHeadless: Boolean(settings.densityWazeHeadless),
    wazeHoldMs: Math.max(0, settings.densityWazeHoldSeconds ?? 0) * 1000,
    wazeCookie: settings.densityWazeCookie || process.env.WAZE_COOKIE || '',
    weight: 1,
  };
}

/** Resolve configured areas, falling back to the single configured city. */
export function resolveAreas(settings: Settings = getSettings()): Area[] {
  const cellMeters = settings.densityCellMeters ?? 150;
  const kernelMeters = settings.densityKernelMeters ?? 300;

  const raw: DensityArea[] = settings.densityAreas?.length
    ? settings.densityAreas
    : settings.lat != null && settings.lng != null
      ? [{ name: settings.city || 'Area', lat: settings.lat, lng: settings.lng, radiusKm: 5.5 }]
      : [];

  return raw
    .map((a) => {
      const bbox =
        a.bbox ??
        (a.lat != null && a.lng != null ? bboxFromRadius(a.lat, a.lng, a.radiusKm ?? 5.5) : null);
      if (!bbox || ![bbox.south, bbox.north, bbox.west, bbox.east].every(Number.isFinite)) return null;
      return {
        name: a.name || 'Area',
        slug: slugify(a.name || 'Area'),
        bbox,
        cellMeters: a.cellMeters ?? cellMeters,
        kernelMeters: a.kernelMeters ?? kernelMeters,
      };
    })
    .filter((a): a is Area => a !== null);
}

/** Areas matching the given names (slug or display name); all when empty. */
export function pickAreas(names?: string[]): Area[] {
  const all = resolveAreas();
  const wanted = (names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return all;
  return all.filter((a) => wanted.includes(a.slug) || wanted.includes(a.name.toLowerCase()));
}
