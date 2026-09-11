import http from 'node:http';
import { config } from './config.js';
import { knownInterests, rememberInterest, runCycle, status } from './crawl.js';
import * as store from './store.js';
import { haversineKm } from './geo.js';

/**
 * The crawler's whole interface: four reads and one trigger.
 *
 * Deliberately not a push. event-scout asks for what it wants when its refresh
 * comes round, which means the crawler never needs a credential for it, never
 * writes to its database, and cannot break it by being wrong — a source that
 * returns nonsense is a source that gets switched off in Settings, and
 * everything else carries on.
 *
 * node:http rather than a framework. Five routes do not need one, and a crawler
 * that pulls in half of npm is a crawler with a supply chain.
 */

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // Read by one program on a private network; no browser, no origins.
    'Cache-Control': 'no-store',
  });
  res.end(text);
};

const num = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const q = url.searchParams;

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, enabled: config.enabled });
  }

  /**
   * What has been found, optionally near somewhere.
   *
   * The area is remembered as well as applied: event-scout's Settings are the
   * only place areas are configured, and asking about one is how the crawler
   * learns what to go looking for next cycle.
   */
  if (req.method === 'GET' && url.pathname === '/events') {
    const city = q.get('city') ?? '';
    const lat = num(q.get('lat'));
    const lng = num(q.get('lng'));
    const radiusKm = num(q.get('radiusKm')) ?? 100;
    if (city) {
      rememberInterest({
        city,
        lat,
        lng,
        radiusKm,
        terms: (q.get('terms') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      });
    }

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
      interests: knownInterests().map((i) => i.city),
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
    if (status().running) return;
    if (knownInterests().length === 0) return; // nothing has asked yet
    runCycle((line) => console.log(line)).catch((err) => console.error('cycle failed:', err));
  };
  setInterval(tick, Math.max(1, config.intervalMinutes) * 60_000).unref();
  // A first pass shortly after boot, once event-scout has had a chance to ask
  // and tell us where to look.
  setTimeout(tick, 90_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // A cycle can be mid-fetch; do not wait forever for it to notice.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
