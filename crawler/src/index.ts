import http from 'node:http';
import { config } from './config.js';
import { crawlUrlNow, hasWork, knownInterests, peekPost, runCycle, setInterests, status } from './crawl.js';
import { haversineKm } from './geo.js';
import { Interest, queriesFor } from './queries.js';
import * as store from './store.js';
import { normalizeUrl } from './urls.js';

/**
 * The crawler's whole interface.
 *
 *   GET  /health   alive, and whether it is enabled
 *   GET  /events   what it has found, near a point if given
 *   GET  /status   what it is doing, and what it is looking for
 *   GET  /feeds    calendar feeds found along the way
 *   GET  /social   Facebook events found along the way, for event-scout to read
 *   GET  /pages    pages read, most-read or latest first, with how often
 *   PUT  /config   where to look, from event-scout
 *   POST /crawl    read one page now and say what was on it
 *   POST /run      start a cycle
 *
 * Deliberately not a push. event-scout asks for what it wants when its refresh
 * comes round, so the crawler never needs a credential for it, never writes to
 * its database, and cannot break it by being wrong — a source that returns
 * nonsense is a source that gets switched off in Settings.
 *
 * Nothing here is authenticated, which is why the container publishes no port:
 * the app reaches it across the compose network and nothing else can.
 *
 * node:http rather than a framework. A handful of routes do not need one, and
 * a crawler that pulls in half of npm is a crawler with a supply chain.
 */

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
};

const num = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A request body as JSON, capped: nothing this accepts is large. */
function readJson(req: http.IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The areas from a PUT /config body, kept to sane sizes.
 *
 * Malformed entries are dropped rather than the whole body refused: event-scout
 * is the only caller, and half a configuration is better than none.
 */
function parseInterests(value: unknown): Interest[] {
  if (!Array.isArray(value)) return [];
  const out: Interest[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const city = String((item as { city?: unknown }).city ?? '').trim().slice(0, 120);
    if (!city) continue;
    const raw = (item as { terms?: unknown }).terms;
    const terms = Array.isArray(raw)
      ? [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))].slice(0, 100)
      : [];
    out.push({ city, terms });
  }
  return out;
}

function parseSeeds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value.slice(0, 300)) {
    const url = normalizeUrl(String(item).trim());
    if (url) out.add(url);
  }
  return [...out];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const q = url.searchParams;

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, enabled: config.enabled });
  }

  /**
   * What has been found, optionally near somewhere. A read and nothing else:
   * where to look arrives separately, on PUT /config.
   */
  if (req.method === 'GET' && url.pathname === '/events') {
    const lat = num(q.get('lat'));
    const lng = num(q.get('lng'));
    const radiusKm = num(q.get('radiusKm')) ?? 100;
    let events = store.finds();
    // Placed events can be filtered here; unplaced ones are passed on, because
    // event-scout geocodes and will place them better than a guess would.
    if (lat !== null && lng !== null) {
      events = events.filter(
        (e) => e.lat == null || e.lng == null || haversineKm(lat, lng, e.lat, e.lng) <= radiusKm
      );
    }
    return json(res, 200, { events, count: events.length });
  }

  /**
   * Where to look, from event-scout: the areas with their search terms, and
   * the pages to read regularly. Replaces what was there, so an area removed
   * in Settings stops being searched; an empty body puts the crawler to rest.
   */
  if (req.method === 'PUT' && url.pathname === '/config') {
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as { interests?: unknown; seeds?: unknown };
        const interests = parseInterests(b.interests);
        setInterests(interests);
        const pinned = store.pinSeeds(parseSeeds(b.seeds));
        json(res, 200, { ok: true, interests: interests.length, seeds: store.listSeeds().length, ...pinned });
      })
      .catch((err: Error) => json(res, 400, { ok: false, message: err.message }));
    return;
  }

  /** Read one page now. Always 200 when it got that far: the outcome is in the body. */
  if (req.method === 'POST' && url.pathname === '/crawl') {
    readJson(req)
      .then((body) => crawlUrlNow(String((body as { url?: unknown } | null)?.url ?? '')))
      .then((report) => json(res, 200, report))
      .catch((err: Error) => json(res, 400, { ok: false, message: err.message, events: [], links: 0, feeds: [] }));
    return;
  }

  /**
   * An Instagram post read for event-scout's "Add from a link": nothing kept,
   * nothing queued. Always 200 when it got that far; the outcome is the body.
   */
  if (req.method === 'POST' && url.pathname === '/read') {
    readJson(req)
      .then((body) => peekPost(String((body as { url?: unknown } | null)?.url ?? '')))
      .then((report) => json(res, 200, report))
      .catch((err: Error) => json(res, 400, { ok: false, message: err.message, events: [] }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    const state = status();
    return json(res, 200, {
      enabled: config.enabled,
      running: state.running,
      current: state.current,
      last: state.last,
      pages: store.countPages(),
      finds: store.countFinds(),
      feeds: store.feeds().length,
      // What it is searching for this hour, per area: the phrases rotate.
      interests: knownInterests().map((i) => ({
        city: i.city,
        terms: i.terms.length,
        thisCycle: queriesFor(i, undefined, undefined, config.social),
      })),
      seeds: store.listSeeds(),
      // The last day or so of cycles, oldest first, for the graph.
      history: store.cycleHistory(48),
      // Instagram read and Facebook events noted. See extract/social.ts.
      social: { enabled: config.social, ...store.countSocial() },
      config: {
        maxPagesPerRun: config.maxPagesPerRun,
        maxDepth: config.maxDepth,
        concurrency: config.concurrency,
        minHostDelayMs: config.minHostDelayMs,
        intervalMinutes: config.intervalMinutes,
        userAgent: config.userAgent,
      },
    });
  }

  /** Pages read, with how many times: `?sort=reads` (the default) or `?sort=recent`. */
  if (req.method === 'GET' && url.pathname === '/pages') {
    const sort = q.get('sort') === 'recent' ? 'recent' : 'reads';
    const limit = Math.min(200, Math.max(1, num(q.get('limit')) ?? 50));
    return json(res, 200, { pages: store.pageList(sort, limit) });
  }

  /**
   * Links the crawler notes but does not read — today, Facebook events, which
   * event-scout reads with the Facebook parser it already has.
   */
  if (req.method === 'GET' && url.pathname === '/social') {
    const kind = q.get('kind') ?? 'facebook-event';
    return json(res, 200, { links: store.socialLinks(kind) });
  }

  /** Calendar feeds found along the way, to paste into event-scout's iCal list. */
  if (req.method === 'GET' && url.pathname === '/feeds') {
    return json(res, 200, { feeds: store.feeds() });
  }

  if (req.method === 'POST' && url.pathname === '/run') {
    if (status().running) return json(res, 409, { ok: false, message: 'already running' });
    // Answered at once: a cycle is minutes long and nothing is waiting on it.
    void runCycle((line) => console.log(line)).catch((err) => console.error('cycle failed:', err));
    return json(res, 202, { ok: true, message: 'started' });
  }

  json(res, 404, { error: 'no such route' });
});

server.listen(config.port, () => {
  console.log(`crawler listening on ${config.port} (enabled: ${config.enabled})`);
  console.log(`  identifying as ${config.userAgent}`);
  console.log(`  ${config.maxPagesPerRun} pages per cycle, depth ${config.maxDepth}, every ${config.intervalMinutes} min`);
  console.log(`  looking in ${knownInterests().length} area(s), ${store.listSeeds().length} pinned page(s)`);
});

/**
 * The schedule.
 *
 * A plain interval rather than cron: there is nothing to line up with, and a
 * crawl that drifts is a crawl that does not hit the same sites at the same
 * minute past every hour.
 */
if (config.enabled) {
  const tick = (): void => {
    if (status().running || !hasWork()) return;
    runCycle((line) => console.log(line)).catch((err) => console.error('cycle failed:', err));
  };
  setInterval(tick, Math.max(1, config.intervalMinutes) * 60_000).unref();
  // A first pass shortly after boot. Where to look survives a restart now, so
  // there is no need to wait for the app to say it again.
  setTimeout(tick, 60_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // A cycle can be mid-fetch; do not wait forever for it to notice.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
