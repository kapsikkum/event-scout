import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKv, getSettings, saveSettings } from './db.js';
import { needsAuth, readCookie, SESSION_COOKIE } from './auth.js';
import { corsDecision, readOrigins } from './cors.js';
import { mergeSecrets, redactSettings } from './secrets.js';
import { flyerRelative, isSafeFlyerPath } from './flyers.js';
import { store } from './flyerStore.js';
import {
  checkPassword,
  apiToken,
  apiTokenValid,
  clearApiToken,
  feedToken,
  feedTokenValid,
  loginBlockedFor,
  newSessionToken,
  noteLoginFailure,
  noteLoginSuccess,
  passwordIsFromEnv,
  passwordRequired,
  regenerateApiToken,
  regenerateFeedToken,
  sessionValid,
  setPassword,
} from './authStore.js';
import { editGroup, EditError, getMergedEvent, getMergedEvents, mergeGroups, setGroupFlag, unmergeGroup } from './events.js';
import { filterEvents, paginate, parseEventQuery, QueryError } from './query.js';
import { geocode } from './geocode.js';
import { buildIcs } from './ics.js';
import { archivePastEvents, getProgress, getStatuses, isRefreshing } from './refresh.js';
import { getPhotoConditions } from './photo.js';
import { listAreas, renderArea, venueHistory, venueReadings } from './density/pipeline.js';
import { pickAreas } from './density/areas.js';
import { getDensityStatus } from './densityRefresh.js';
import { clearEnrichment, getLlmStatus } from './enrich/pipeline.js';
import { clearVision } from './enrich/visionPipeline.js';
import { ENRICH_JOBS } from './enrich/schema.js';
import { tasks } from './tasks/tasks.js';
import { runDueTasksOnStartup, startScheduler } from './tasks/scheduler.js';
import { DEFAULT_SETTINGS, Settings } from './sources/types.js';
import { EVENT_TOPICS } from './sources/topics.js';
import { versionInfo } from './version.js';

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
/**
 * Cross-origin reads, for the origins the operator named.
 *
 * Ahead of the gate below because a preflight carries no cookie by definition,
 * and answering it with "sign in" would tell a browser the wrong thing. Nothing
 * is granted here that the gate would refuse — corsDecision applies the same
 * `needsAuth` rule — so ordering them this way costs nothing.
 */
app.use('/api', (req, res, next) => {
  const decision = corsDecision(
    {
      origin: req.headers.origin,
      method: req.method,
      path: req.baseUrl + req.path,
      requestMethod: req.headers['access-control-request-method'] as string | undefined,
    },
    readOrigins(getSettings().corsOrigins)
  );
  if (decision) {
    // vary() adds to what is already there; set() would replace it.
    res.vary(decision.vary);
    res.set(decision.headers);
    // Answered here rather than passed on: there is no route for OPTIONS, and
    // a preflight wants headers and a success status, nothing else.
    if (decision.preflight) return res.sendStatus(204);
  }
  next();
});

app.use('/api', (req, res, next) => {
  if (!passwordRequired()) return next();
  if (!needsAuth(req.method, req.baseUrl + req.path)) return next();
  if (sessionValid(readCookie(req.headers.cookie, SESSION_COOKIE))) return next();
  // A script cannot hold a cookie, so a bearer token is the same authority in a
  // form curl can send. Never granted across origins: Authorization is not on
  // the CORS allowed-headers list, so a browser on another site cannot send it.
  if (apiTokenValid(req.headers.authorization)) return next();
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

/**
 * The API token. Gated like the feed token, and for the same reason: handing it
 * out is handing over the thing it protects.
 */
app.get('/api/auth/token', (_req, res) => {
  res.json({ token: apiToken() });
});

app.post('/api/auth/token', (_req, res) => {
  res.json({ token: regenerateApiToken() });
});

app.delete('/api/auth/token', (_req, res) => {
  clearApiToken();
  res.json({ token: '' });
});

/**
 * The credentials are never sent back — see secrets.ts. The page is told which
 * are set, which is all it has ever needed to know.
 */
app.get('/api/settings', (_req, res) => {
  res.json(redactSettings(getSettings()));
});

app.put('/api/settings', (req, res) => {
  const current = getSettings();
  const body = req.body as Partial<Settings>;
  const next: Settings = {
    ...current,
    ...body,
    enabledSources: { ...current.enabledSources, ...(body.enabledSources ?? {}) },
    // After the spread, so a blanked credential coming back from the page
    // cannot overwrite the stored one. Null is how a caller asks to clear one.
    ...mergeSecrets(current, (req.body ?? {}) as Record<string, unknown>),
  };
  // Keep arrays sane if the client sends junk
  for (const key of ['eventbriteOrganizerIds', 'fbSearchTerms', 'fbPages', 'icalFeeds', 'eventTopics', 'eventAreas', 'midnightspecStates', 'tasksDisabled', 'llmJobs', 'corsOrigins'] as const) {
    if (!Array.isArray(next[key])) (next as unknown as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
  }
  saveSettings(next);
  // Redacted on the way out too, or the answer would hand straight back what
  // the request was careful not to ask for.
  res.json(redactSettings(next));
});

// Open, and deliberately so: "what is this instance running" is the first
// question when something looks wrong, and needing to sign in to ask it would
// be the wrong way round.
app.get('/api/version', (_req, res) => {
  res.json(versionInfo());
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

/**
 * The list, whole or narrowed.
 *
 * With no parameters this answers exactly what it always has — every upcoming
 * event, as an array — because the web app fetches once and filters in the
 * browser. The filters are for everything else, which would otherwise pull a
 * megabyte to answer a question about one weekend in one town.
 *
 * The page is still a bare array rather than an envelope, so adding this broke
 * nothing; the count it was taken from goes in a header. Express already
 * answers a matching `If-None-Match` with a 304, so a poller that has not
 * missed anything pays for the headers only.
 */
app.get('/api/events', (req, res) => {
  let query;
  try {
    query = parseEventQuery(req.query as Record<string, unknown>);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const found = filterEvents(getMergedEvents({ archived: query.archived }), query);
  const { page, total } = paginate(found, query);
  res.set('X-Total-Count', String(total));
  res.json(page);
});

/**
 * Change an event by hand, from edit mode on the Events page.
 *
 * A write, so the password gates it like any other. Send only the fields you
 * are changing; send a field as "" or null to drop the override and put back
 * whatever the sources, the flyer or the model would have shown.
 */
app.patch('/api/events/:group', (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json({ ...editGroup(req.params.group, body), event: getMergedEvent(req.params.group) });
  } catch (err) {
    if (err instanceof EditError) {
      return res.status(/^Unknown event/.test(err.message) ? 404 : 400).json({ error: err.message });
    }
    throw err;
  }
});

app.get('/api/events/:group', (req, res) => {
  const event = getMergedEvent(req.params.group);
  if (!event) return res.status(404).json({ error: `Unknown event: ${req.params.group}` });
  res.json(event);
});

app.post('/api/archive', (_req, res) => {
  res.json(archivePastEvents());
});

/**
 * A stored flyer.
 *
 * Open, like everything else that only reads: the picture is already on the
 * card, and a copy of it is no more secret than the original. Both halves of
 * the path are checked against the shapes this app writes before anything
 * touches the disk, so a request cannot climb out of the folder.
 */
app.get('/api/flyer/:day/:name', (req, res) => {
  const { day, name } = req.params;
  if (!isSafeFlyerPath(day, name)) return res.status(404).json({ error: 'No such flyer' });
  const relative = flyerRelative(day, name);
  if (!store.has(relative)) return res.status(404).json({ error: 'No such flyer' });
  // Named by a hash of the address it came from, so it never changes once
  // written and can be cached hard.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(store.absolute(relative));
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

// --- local model ------------------------------------------------------------

app.get('/api/llm/status', async (_req, res) => {
  res.json({ ...(await getLlmStatus()), availableJobs: ENRICH_JOBS });
});

// Forget every verdict so the next pass reconsiders everything. What you reach
// for after changing model or prompt; the scraped values are untouched.
app.post('/api/llm/reset', (_req, res) => {
  res.json({ ok: true, cleared: clearEnrichment() });
});

app.post('/api/vision/reset', (_req, res) => {
  res.json({ ok: true, cleared: clearVision() });
});

// --- tasks ------------------------------------------------------------------

app.get('/api/tasks', (req, res) => {
  // ?since= returns only console lines newer than that sequence number, so the
  // page's three-second poll carries the two lines that are new rather than the
  // five hundred it already has.
  const since = Number(req.query.since);
  const log = tasks.since(Number.isFinite(since) ? since : 0);
  res.json({ tasks: tasks.statuses(), log: log.entries, seq: log.seq });
});

app.post('/api/tasks/:name/run', async (req, res) => {
  const result = await tasks.run(req.params.name, { force: true });
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

/**
 * An unknown /api path is a 404 in JSON, not Express's HTML page.
 *
 * Placed after every route and before the handler below. Without it a client
 * that misspelled a path — or called one this version does not have — got a
 * page of markup where the API had promised an object.
 */
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.baseUrl}${req.path}` });
});

/**
 * Every failure under /api answers in the shape the rest of the API uses.
 *
 * Without this, Express's own handler replies with an HTML page — so a client
 * that sent a malformed JSON body got `<!DOCTYPE html>` where it was promised
 * `{ "error": ... }`, which is reachable today and not hypothetical. Mounted on
 * /api alone so the static frontend below keeps Express's behaviour.
 *
 * The message is only passed on for the 4xx range, where it describes what the
 * caller did. A 500 is this app's fault, and what went wrong inside it is for
 * the log rather than the response.
 */
app.use('/api', (err: Error & { status?: number; statusCode?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message || 'Bad request' });
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
