import { fetchJson, sleep, HttpError } from '../http.js';
import { tileBbox, densifyLine, polylineLength, inBbox, Point } from '../geo.js';
import type { Area } from '../areas.js';
import type { Observation } from '../store.js';
import { USER_AGENT } from '../../useragent.js';

/**
 * Waze live-map jams, alerts and wazer positions.
 *
 * Two transports share the parsing in this file.
 *
 * The direct fetch below is refused with HTTP 403. The endpoint is fronted by
 * reCAPTCHA Enterprise and expects an `X-Recaptcha-Token` minted in a browser;
 * notably the real client sends the request with `withCredentials: false`, so a
 * signed-in session is refused exactly like an anonymous one and no cookie can
 * change that. Minting that token from a script would be bot-detection bypass,
 * which this project does not do.
 *
 * The transport that actually works is `wazeBrowser.ts`: a real browser loads
 * the live map, that page mints its own token and issues its own requests, and
 * we read the responses it received. Nothing is forged and no check is solved —
 * the window is visible, so if Waze wants human interaction the human provides
 * it directly.
 */

const ENDPOINT = 'https://www.waze.com/live-map/api/georss';
const RECAPTCHA_NOTE = 'requires an X-Recaptcha-Token header (reCAPTCHA Enterprise)';

const HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-AU,en;q=0.9',
  Referer: 'https://www.waze.com/live-map',
  Origin: 'https://www.waze.com',
};

/** How much each alert type says about "there are people or vehicles here". */
const ALERT_WEIGHTS: Record<string, number> = {
  JAM: 1.0,
  ROAD_CLOSED: 0.9,
  ACCIDENT: 0.8,
  HAZARD: 0.5,
  POLICE: 0.4,
  CONSTRUCTION: 0.4,
  WEATHERHAZARD: 0.3,
  CHIT_CHAT: 0.2,
};

export interface WazeJam {
  uuid?: string; id?: number; level?: number; delay?: number; length?: number;
  speedKMH?: number; street?: string; city?: string; line?: { x: number; y: number }[];
}
export interface WazeAlert {
  uuid?: string; id?: number; type?: string; subtype?: string;
  reliability?: number; nThumbsUp?: number; street?: string; city?: string;
  reportDescription?: string; pubMillis?: number;
  location?: { x: number; y: number };
}
export interface WazeUser {
  uuid?: string; id?: string | number; speed?: number; speedKMH?: number;
  location?: { x?: number; y?: number; latitude?: number; longitude?: number };
  x?: number; y?: number;
}
export interface WazeFeed { jams?: WazeJam[]; alerts?: WazeAlert[]; users?: WazeUser[] }

export interface WazeSummary {
  tiles: number; tilesAttempted: number; tilesFailed: number;
  jams: number; alerts: number; users: number; blocked: string | null;
}

export interface WazeResult {
  observations: Observation[];
  summary: WazeSummary;
}

/**
 * Jam severity on 0..1. Waze's own `level` is 0-5; delay (seconds lost) is a
 * better discriminator at the top end, and -1 means the road is closed.
 */
export function jamSeverity(jam: WazeJam): number {
  if (jam.delay === -1) return 1;
  const byLevel = Math.max(0, Math.min(5, jam.level ?? 0)) / 5;
  const byDelay = Math.min(Math.max(jam.delay ?? 0, 0) / 600, 1);
  return Math.max(byLevel, byDelay);
}

/**
 * A wazer's position. The feed has carried this under `location: {x, y}` and,
 * in older responses, flat on the object; speed has appeared both in m/s and
 * as `speedKMH`. Accept every variant and skip anything without coordinates.
 */
export function userPoint(user: WazeUser): { lat: number; lon: number; speedKmh: number | null } | null {
  const loc = user.location ?? user;
  const lat = (loc as { y?: number; latitude?: number }).y ?? (loc as { latitude?: number }).latitude;
  const lon = (loc as { x?: number; longitude?: number }).x ?? (loc as { longitude?: number }).longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const speedKmh = user.speedKMH ?? (typeof user.speed === 'number' ? user.speed * 3.6 : null);
  return { lat, lon, speedKmh };
}

export interface WazeParseOptions {
  sampleMeters?: number;
  stationaryBoost?: number;
}

/**
 * Accumulates feeds into observations.
 *
 * Kept as a class because both transports feed it many overlapping responses —
 * tiles overlap at their seams, and a browser panning the map re-fetches ground
 * it already covered — so de-duplication has to span the whole pass rather than
 * a single response.
 */
export class WazeCollector {
  readonly observations: Observation[] = [];
  private seenJams = new Set<string>();
  private seenAlerts = new Set<string>();
  private seenUsers = new Set<string>();
  jams = 0;
  alerts = 0;
  users = 0;

  constructor(private area: Area, private opts: WazeParseOptions = {}) {}

  /** Fold one georss response into the run. Returns how many rows were new. */
  add(feed: WazeFeed): number {
    const before = this.observations.length;
    const sampleMeters = this.opts.sampleMeters ?? 100;
    const stationaryBoost = this.opts.stationaryBoost ?? 1.5;
    const bbox = this.area.bbox;

    for (const jam of feed.jams ?? []) {
      const key = jam.uuid ?? String(jam.id);
      if (this.seenJams.has(key)) continue;
      this.seenJams.add(key);

      const line: Point[] = (jam.line ?? []).map((p) => ({ lat: p.y, lon: p.x }));
      if (line.length === 0) continue;
      const severity = jamSeverity(jam);
      this.jams++;

      for (const p of densifyLine(line, sampleMeters)) {
        if (!inBbox(bbox, p.lat, p.lon)) continue;
        this.observations.push({
          source: 'waze-jam',
          kind: 'level-' + String(jam.level ?? 0),
          lat: p.lat, lon: p.lon,
          weight: severity,
          meta: {
            street: jam.street ?? null, city: jam.city ?? null,
            speedKmh: jam.speedKMH ?? null, delaySec: jam.delay ?? null,
            lengthM: Math.round(jam.length ?? polylineLength(line)),
          },
        });
      }
    }

    for (const alert of feed.alerts ?? []) {
      const key = alert.uuid ?? String(alert.id);
      if (this.seenAlerts.has(key)) continue;
      this.seenAlerts.add(key);

      const loc = alert.location;
      if (!loc || !inBbox(bbox, loc.y, loc.x)) continue;
      const base = ALERT_WEIGHTS[alert.type ?? ''] ?? 0.3;
      // Discount reports the crowd hasn't corroborated.
      const trust = 0.5 + 0.5 * Math.min((alert.reliability ?? 5) / 10, 1);
      this.alerts++;
      this.observations.push({
        source: 'waze-alert',
        kind: alert.subtype || alert.type || 'UNKNOWN',
        lat: loc.y, lon: loc.x,
        weight: base * trust,
        meta: {
          type: alert.type ?? null,
          subtype: alert.subtype ?? null,
          street: alert.street ?? null,
          city: alert.city ?? null,
          description: alert.reportDescription ?? null,
          reportedAt: alert.pubMillis ? new Date(alert.pubMillis).toISOString() : null,
          reliability: alert.reliability ?? null,
          thumbsUp: alert.nThumbsUp ?? 0,
        },
      });
    }

    for (const user of feed.users ?? []) {
      const key = user.uuid ?? String(user.id ?? '');
      if (key && this.seenUsers.has(key)) continue;
      if (key) this.seenUsers.add(key);

      const point = userPoint(user);
      if (!point || !inBbox(bbox, point.lat, point.lon)) continue;
      this.users++;

      // Every wazer counts once. A stationary one can count for more: a car
      // park full of parked drivers is a gathering, whereas the same people
      // moving are just throughput.
      const stationary = point.speedKmh != null && point.speedKmh < 5;
      this.observations.push({
        source: 'waze-users',
        kind: stationary ? 'stationary' : 'moving',
        lat: point.lat, lon: point.lon,
        weight: stationary ? stationaryBoost : 1,
        meta: { speedKmh: point.speedKmh == null ? null : Math.round(point.speedKmh) },
      });
    }

    return this.observations.length - before;
  }
}

export interface WazeOptions extends WazeParseOptions {
  env?: string;
  tileSpanDeg?: number;
  requestDelayMs?: number;
  cookie?: string;
}

/**
 * Direct fetch of the georss endpoint. Retained because it is the documented
 * shape of the API and costs nothing to attempt, but it answers 403 without a
 * browser-minted token. See the note at the top of this file.
 */
export async function scrapeWaze(
  area: Area, opts: WazeOptions = {}, log: (msg: string) => void = () => {}
): Promise<WazeResult> {
  const env = opts.env ?? 'row';
  const delay = opts.requestDelayMs ?? 700;

  const tiles = tileBbox(area.bbox, opts.tileSpanDeg ?? 0.06);
  const headers = opts.cookie ? { ...HEADERS, Cookie: opts.cookie } : HEADERS;
  const collector = new WazeCollector(area, opts);

  let failed = 0;
  let attempted = 0;
  let blocked: string | null = null;
  const failures = new Map<string, number>();

  for (const [i, tile] of tiles.entries()) {
    attempted++;
    try {
      const q = new URLSearchParams({
        top: String(tile.north), bottom: String(tile.south),
        left: String(tile.west), right: String(tile.east),
        env, types: 'alerts,traffic,users',
      });
      collector.add(await fetchJson<WazeFeed>(ENDPOINT + '?' + q.toString(), { headers }));
    } catch (err) {
      failed++;
      const status = err instanceof HttpError ? err.status : 0;
      const reason = status === 403 ? 'HTTP 403 - ' + RECAPTCHA_NOTE
        : status ? 'HTTP ' + status : (err as Error).message;
      if (status === 403) blocked = RECAPTCHA_NOTE;
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
      // If the endpoint is refusing us outright the rest will fail identically.
      if (failed === 3 && failures.size === 1 && collector.observations.length === 0) {
        log('  waze: aborting after 3 identical failures (' + reason + ')');
        break;
      }
      await sleep(delay);
      continue;
    }
    if (i < tiles.length - 1) await sleep(delay);
  }

  for (const [reason, count] of failures) {
    log(`  waze: ${count}/${tiles.length} tile${count === 1 ? '' : 's'} failed - ${reason}`);
  }

  return {
    observations: collector.observations,
    summary: {
      tiles: tiles.length, tilesAttempted: attempted, tilesFailed: failed,
      jams: collector.jams, alerts: collector.alerts, users: collector.users, blocked,
    },
  };
}
