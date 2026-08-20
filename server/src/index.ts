import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { getKv, getSettings, saveSettings } from './db.js';
import { getMergedEvents, mergeGroups, setGroupFlag, unmergeGroup } from './events.js';
import { geocode } from './geocode.js';
import { buildIcs } from './ics.js';
import { archivePastEvents, getProgress, getStatuses, isRefreshing, refreshAll } from './refresh.js';
import { getPhotoConditions } from './photo.js';
import { listAreas, renderArea, venueHistory, venueReadings, wazeSnapshot } from './density/pipeline.js';
import { pickAreas } from './density/areas.js';
import {
  discoverVenues as discoverDensityVenues,
  getDensityStatus,
  refreshDensity,
  refreshDensityIfDue,
  refreshWaze,
  wazeSignIn,
} from './densityRefresh.js';
import { DEFAULT_SETTINGS, Settings } from './sources/types.js';
import { EVENT_TOPICS } from './sources/topics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/settings', (_req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  const current = getSettings();
  const body = req.body as Partial<Settings>;
  const next: Settings = {
    ...current,
    ...body,
    enabledSources: { ...current.enabledSources, ...(body.enabledSources ?? {}) },
  };
  // Keep arrays sane if the client sends junk
  for (const key of ['eventbriteOrganizerIds', 'fbSearchTerms', 'fbPages', 'icalFeeds', 'eventTopics', 'eventAreas'] as const) {
    if (!Array.isArray(next[key])) (next as unknown as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
  }
  saveSettings(next);
  res.json(next);
});

app.get('/api/topics', (_req, res) => {
  res.json({ topics: EVENT_TOPICS });
});

app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    res.json(await geocode(q));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/api/events', (req, res) => {
  // ?archived=1 returns past events instead of upcoming ones.
  res.json(getMergedEvents({ archived: req.query.archived === '1' }));
});

app.post('/api/archive', (_req, res) => {
  res.json(archivePastEvents());
});

app.get('/api/photo', async (req, res) => {
  res.json(await getPhotoConditions(req.query.force === '1'));
});

// --- density ----------------------------------------------------------------

app.get('/api/density/status', (_req, res) => {
  res.json(getDensityStatus());
});

app.post('/api/density/refresh', async (_req, res) => {
  const result = await refreshDensity(true);
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/density/discover', async (_req, res) => {
  const result = await discoverDensityVenues();
  res.status(result.ok ? 200 : 409).json(result);
});

app.get('/api/density/areas', (_req, res) => {
  res.json({ areas: listAreas() });
});

app.get('/api/density/:area', (req, res) => {
  const [area] = pickAreas([req.params.area]);
  if (!area) return res.status(404).json({ error: `Unknown area: ${req.params.area}` });
  // Rendered on demand, so the map always reflects the latest pass.
  const geojson = renderArea(area, {
    hours: req.query.hours ? Number(req.query.hours) : undefined,
    all: req.query.all === '1',
    hourOfDay: req.query.hour != null ? Number(req.query.hour) : undefined,
    daysOfWeek: req.query.days ? String(req.query.days).split(',').map(Number) : undefined,
  });
  if (!geojson) return res.status(404).json({ error: 'No observations for that area yet.' });
  res.json(geojson);
});

app.get('/api/density/:area/history', (req, res) => {
  const [area] = pickAreas([req.params.area]);
  if (!area) return res.status(404).json({ error: `Unknown area: ${req.params.area}` });
  const name = String(req.query.venue ?? '');
  if (!name) return res.status(400).json({ error: 'venue is required' });
  const history = venueHistory(area, name, req.query.days ? Number(req.query.days) : 14);
  if (!history) return res.status(404).json({ error: `Unknown venue: ${name}` });
  res.json(history);
});

app.get('/api/density/:area/venues', (req, res) => {
  const [area] = pickAreas([req.params.area]);
  if (!area) return res.status(404).json({ error: `Unknown area: ${req.params.area}` });
  res.json(venueReadings(area));
});

app.get('/api/density/:area/waze', (req, res) => {
  const [area] = pickAreas([req.params.area]);
  if (!area) return res.status(404).json({ error: `Unknown area: ${req.params.area}` });
  res.json(wazeSnapshot(area, req.query.hours ? Number(req.query.hours) : 3));
});

// Opens the Waze live map in a browser and reads what that page fetches. Slow
// and visible on purpose - the window is there to be driven by hand.
app.post('/api/density/waze', async (req, res) => {
  const hold = Number((req.body as { holdSeconds?: number } | undefined)?.holdSeconds ?? 0);
  const result = await refreshWaze(Number.isFinite(hold) ? hold : 0);
  res.status(result.ok ? 200 : 409).json(result);
});

// Opens the live map and waits while the user signs in to Waze themselves.
// No credentials pass through here: they use Waze's own form or QR code.
app.post('/api/density/waze/signin', async (req, res) => {
  const hold = Number((req.body as { holdSeconds?: number } | undefined)?.holdSeconds ?? 180);
  const result = await wazeSignIn(Number.isFinite(hold) ? hold : 180);
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/merge', (req, res) => {
  const { groups } = req.body as { groups?: string[] };
  if (!Array.isArray(groups) || groups.length < 2) {
    return res.status(400).json({ error: 'Pick at least two events to merge' });
  }
  try {
    res.json(mergeGroups(groups));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/unmerge/:group', (req, res) => {
  res.json(unmergeGroup(req.params.group));
});

app.post('/api/groups/:group', (req, res) => {
  const { starred, hidden } = req.body as { starred?: boolean; hidden?: boolean };
  if (typeof starred === 'boolean') setGroupFlag(req.params.group, 'starred', starred);
  if (typeof hidden === 'boolean') setGroupFlag(req.params.group, 'hidden', hidden);
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => {
  res.json({
    sources: getStatuses(),
    lastRefresh: getKv('lastRefresh'),
    refreshing: isRefreshing(),
    // What the run is doing and what it has found so far. Cheap enough to
    // send on every poll: it is a few dozen short strings held in memory.
    progress: getProgress(),
    density: getDensityStatus(),
  });
});

app.post('/api/refresh', async (_req, res) => {
  try {
    const statuses = await refreshAll();
    res.json({ sources: statuses, lastRefresh: getKv('lastRefresh') });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

/**
 * The calendar feed.
 *
 * Filters mirror the Calendar page, so whatever is on screen is what a
 * subscriber gets. Served without Content-Disposition when subscribed to, since
 * a download prompt is not what a calendar client wants.
 */
function calendarFeed(req: express.Request, res: express.Response, download: boolean): void {
  const starredOnly = req.query.starred === '1';
  const category = String(req.query.category ?? '').trim();
  const days = Number(req.query.days);

  let events = getMergedEvents().filter((ev) => !ev.hidden);
  if (starredOnly) events = events.filter((ev) => ev.starred);
  if (category) events = events.filter((ev) => ev.category === category);
  if (Number.isFinite(days) && days > 0) {
    const until = Date.now() + days * 86400_000;
    events = events.filter((ev) => Date.parse(ev.startTime) <= until);
  }

  const name = [
    'Event Scout',
    starredOnly ? 'shortlist' : null,
    category || null,
    getSettings().city || null,
    // A plain hyphen, not the middle dot used elsewhere in the UI: Outlook is
    // the fussiest consumer of this name and there is nothing to gain from
    // putting a non-ASCII character in front of it.
  ].filter(Boolean).join(' - ');

  const ics = buildIcs(
    events.map((ev) => ({
      uid: ev.group,
      title: ev.title,
      description: ev.description,
      startTime: ev.startTime,
      endTime: ev.endTime,
      venueName: ev.venueName,
      address: ev.address,
      url: ev.sources.find((s) => s.url)?.url ?? '',
      category: ev.category,
      lat: ev.lat,
      lng: ev.lng,
    })),
    { name, description: `${events.length} events from Event Scout` }
  );

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  if (download) {
    res.setHeader('Content-Disposition', 'attachment; filename="event-scout.ics"');
  }
  res.send(ics);
}

// Subscribe URL: no download prompt, so a calendar client can poll it.
app.get('/api/calendar.ics', (req, res) => calendarFeed(req, res, false));

app.get('/api/export.ics', (req, res) => {
  // Kept as the shortlist download the Events page links to.
  if (req.query.starred == null) req.query.starred = '1';
  calendarFeed(req, res, true);
});

// Serve the built frontend in production (`npm run build` then `npm start`).
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

const PORT = Number(process.env.API_PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`event-scout server listening on http://localhost:${PORT}`);
});

// Auto-refresh: on startup (after a beat) and hourly, when the cache is stale.
const STALE_MS = 6 * 3600 * 1000;
async function refreshIfStale(): Promise<void> {
  const settings = getSettings();
  if (settings.lat == null || settings.lng == null || isRefreshing()) return;
  const last = getKv('lastRefresh');
  if (last && Date.now() - Date.parse(last) < STALE_MS) return;
  try {
    await refreshAll();
    console.log('Auto-refresh complete');
  } catch (err) {
    console.error('Auto-refresh failed:', (err as Error).message);
  }
}
setTimeout(refreshIfStale, 5000);
cron.schedule('15 * * * *', refreshIfStale);

// Density is sampled far more often than events, so it gets its own tick. The
// job itself decides whether the configured interval has actually elapsed.
cron.schedule('*/5 * * * *', () => {
  void refreshDensityIfDue().catch((err) => console.error('Density refresh failed:', err.message));
});
