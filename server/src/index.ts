import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKv, getSettings, saveSettings } from './db.js';
import {
  checkPassword,
  feedToken,
  feedTokenValid,
  loginBlockedFor,
  needsAuth,
  newSessionToken,
  noteLoginFailure,
  noteLoginSuccess,
  passwordIsFromEnv,
  passwordRequired,
  readCookie,
  regenerateFeedToken,
  sessionValid,
  setPassword,
  SESSION_COOKIE,
} from './auth.js';
import { getMergedEvents, mergeGroups, setGroupFlag, unmergeGroup } from './events.js';
import { geocode } from './geocode.js';
import { buildIcs } from './ics.js';
import { archivePastEvents, getProgress, getStatuses, isRefreshing } from './refresh.js';
import { getPhotoConditions } from './photo.js';
import { listAreas, renderArea, venueHistory, venueReadings, wazeSnapshot } from './density/pipeline.js';
import { pickAreas } from './density/areas.js';
import { getDensityStatus } from './densityRefresh.js';
import { tasks } from './tasks/tasks.js';
import { runDueTasksOnStartup, startScheduler } from './tasks/scheduler.js';
import { DEFAULT_SETTINGS, Settings } from './sources/types.js';
import { EVENT_TOPICS } from './sources/topics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * Reading is open; changing anything is not.
 *
 * One rule applied to every route rather than a check inside each of them, so
 * that a route added later is covered by default instead of by remembering.
 * With no password configured nothing is gated and the app behaves as it always
 * has — the Settings page says so plainly rather than leaving it to be found.
 */
app.use('/api', (req, res, next) => {
  if (!passwordRequired()) return next();
  if (!needsAuth(req.method, req.baseUrl + req.path)) return next();
  if (sessionValid(readCookie(req.headers.cookie, SESSION_COOKIE))) return next();
  res.status(401).json({ error: 'Sign in to change this' });
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    required: passwordRequired(),
    authed:
      !passwordRequired() || sessionValid(readCookie(req.headers.cookie, SESSION_COOKIE)),
    fromEnv: passwordIsFromEnv(),
  });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  const blocked = loginBlockedFor(ip);
  if (blocked > 0) {
    return res.status(429).json({ error: `Too many attempts — try again in ${Math.ceil(blocked / 1000)}s` });
  }
  const { password } = req.body as { password?: string };
  if (typeof password !== 'string' || !checkPassword(password)) {
    noteLoginFailure(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }
  noteLoginSuccess(ip);
  const { token, maxAgeMs } = newSessionToken();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Only over HTTPS when the request arrived that way; forcing it would make
    // the cookie silently useless on a plain-http LAN address, which is how
    // this is usually reached.
    secure: req.protocol === 'https',
    maxAge: maxAgeMs,
  });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

/**
 * Set or clear the password.
 *
 * Reachable without a session only while none is set — that is the first-run
 * case. Once one exists the middleware above requires a session to get here,
 * and the current password is asked for as well, so a borrowed browser cannot
 * be used to lock the owner out.
 */
app.post('/api/auth/password', (req, res) => {
  if (passwordIsFromEnv()) {
    return res.status(400).json({ error: 'The password is set by AUTH_PASSWORD and cannot be changed here' });
  }
  const { current, next } = req.body as { current?: string; next?: string };
  if (passwordRequired() && !checkPassword(String(current ?? ''))) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  if (typeof next !== 'string') return res.status(400).json({ error: 'next is required' });
  if (next && next.length < 8) return res.status(400).json({ error: 'Use at least 8 characters' });
  setPassword(next);
  if (next) {
    const { token, maxAgeMs } = newSessionToken();
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: maxAgeMs,
    });
  }
  res.json({ ok: true, required: passwordRequired() });
});

app.get('/api/auth/feed-token', (_req, res) => {
  res.json({ token: feedToken() });
});

app.post('/api/auth/feed-token', (_req, res) => {
  res.json({ token: regenerateFeedToken() });
});

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
  for (const key of ['eventbriteOrganizerIds', 'fbSearchTerms', 'fbPages', 'icalFeeds', 'eventTopics', 'eventAreas', 'midnightspecStates', 'tasksDisabled'] as const) {
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

// Kept as the buttons the density panel already links to; both go through the
// registry so they take the same browser lock as everything else.
app.post('/api/density/refresh', async (_req, res) => {
  const result = await tasks.run('density', { force: true });
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/density/discover', async (_req, res) => {
  const result = await tasks.run('densityDiscover', { force: true });
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
  const result = await tasks.run('waze', {
    force: true,
    arg: { holdSeconds: Number.isFinite(hold) ? hold : 0 },
  });
  res.status(result.ok ? 200 : 409).json(result);
});

// Opens the live map and waits while the user signs in to Waze themselves.
// No credentials pass through here: they use Waze's own form or QR code.
app.post('/api/density/waze/signin', async (req, res) => {
  const hold = Number((req.body as { holdSeconds?: number } | undefined)?.holdSeconds ?? 180);
  const result = await tasks.run('wazeSignIn', {
    force: true,
    arg: { holdSeconds: Number.isFinite(hold) ? hold : 180 },
  });
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
  // Through the registry rather than straight to refreshAll, so the Tasks page
  // records a hand-driven refresh the same as a scheduled one.
  const result = await tasks.run('events', { force: true });
  if (!result.ok) return res.status(409).json({ error: result.message });
  res.json({ sources: getStatuses(), lastRefresh: getKv('lastRefresh') });
});

// --- tasks ------------------------------------------------------------------

app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: tasks.statuses() });
});

app.post('/api/tasks/:name/run', async (req, res) => {
  const hold = Number((req.body as { holdSeconds?: number } | undefined)?.holdSeconds);
  const result = await tasks.run(req.params.name, {
    force: true,
    arg: Number.isFinite(hold) ? { holdSeconds: hold } : {},
  });
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/tasks/:name/enable', (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  const result = tasks.setEnabled(req.params.name, enabled);
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * The calendar feed.
 *
 * Filters mirror the Calendar page, so whatever is on screen is what a
 * subscriber gets. Served without Content-Disposition when subscribed to, since
 * a download prompt is not what a calendar client wants.
 */
function calendarFeed(req: express.Request, res: express.Response, download: boolean): void {
  // A calendar client cannot sign in, so the feed carries its secret in the URL
  // instead. Only enforced once a password exists, which is what lets an
  // already-subscribed URL keep working right up until authentication is on.
  // A signed-in browser is let through without one, so the Calendar page works.
  const authed = sessionValid(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!authed && !feedTokenValid(req.query.token)) {
    res.status(401).type('text/plain').send('This calendar feed needs its token. Copy the subscribe URL from Settings.');
    return;
  }

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

/**
 * The background jobs, all of them, on the schedules they have always run on.
 *
 * These were four hand-written cron entries with their state scattered behind
 * them. They are task definitions now (see tasks/tasks.ts), which is what lets
 * the Tasks page say when each last ran and run one on demand.
 *
 * Archiving still gets its own schedule rather than riding along with a
 * refresh: events go stale whether or not new ones are arriving, and when a
 * hung source held the refresh flag for ten days, yesterday events sat at the
 * top of the list the whole time.
 */
startScheduler();
runDueTasksOnStartup();
