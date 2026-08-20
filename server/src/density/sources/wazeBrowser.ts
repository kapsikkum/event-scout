import { Browser, Page, openBrowser } from '../cdp.js';
import { sleep } from '../http.js';
import { bboxCentre, tileBbox } from '../geo.js';
import type { Area } from '../areas.js';
import { WazeCollector, WazeFeed, WazeResult } from './waze.js';

/**
 * Waze live-map data, read out of a real browser.
 *
 * The georss endpoint will not answer a scripted request. Rather than forge
 * anything, this opens the live map in a browser and reads the responses that
 * page received: the page makes its own requests, exactly as it does for any
 * visitor.
 *
 * It does not currently return data, and the reason is settled. Captured from
 * the page's own georss request:
 *
 *     X-Recaptcha-Token: ARoOpMyPxQnjAl4L2UQ9A35OHUJcJLrKBYo-82Qu84gg…
 *     Accept: application/json, text/plain, *\/*
 *     (no Cookie header)
 *
 * — answered 403. So the page mints a genuine reCAPTCHA Enterprise token, sends
 * it, and Waze scores it and refuses. Two things follow.
 *
 * Credentials are irrelevant. The request carries no cookies by the client's own
 * design, so neither a pasted session nor a signed-in profile changes anything;
 * both were tried and both were refused identically. A "Connect your Waze
 * account" dialog does appear on the page, which is misleading — it is a prompt,
 * not the gate, and the 403s continue with it dismissed.
 *
 * And what is left is a behavioural score, which only deception would raise:
 * fingerprint patching, faked interaction, or relaying a token minted in
 * someone's real browser. That is bot-detection bypass and this project does not
 * do it, so this transport stays as it is. It reads whatever the page is given
 * and will start producing data the moment Waze answers one of these requests.
 *
 * The profile stays separate from the one Google Maps uses: two browsers cannot
 * share a profile directory.
 */

const GEORSS = '/live-map/api/georss';

/** How much ground one zoom-13 viewport covers, near enough. */
const VIEW_SPAN_DEG = 0.12;

export interface WazeBrowserOptions {
  browserPath?: string | null;
  /** Visible by default; the user may need to sign in. */
  headless?: boolean;
  profileDir: string;
  zoom?: number;
  /** Time to let a view settle and issue its requests. */
  waitMs?: number;
  /** Extra time to keep the window open and keep collecting, for the user. */
  holdMs?: number;
  maxViews?: number;
  /** A Waze cookie the user exported from their own browser. */
  cookie?: string;
  sampleMeters?: number;
  stationaryBoost?: number;
}

interface Capture {
  feeds: WazeFeed[];
  statuses: Map<number, number>;
  /** Set once the page has been seen asking for the live-map API at all. */
  requested: boolean;
}

/**
 * Parse a cookie the user pasted.
 *
 * Accepts both shapes people actually have to hand: a request header copied out
 * of devtools (`a=1; b=2`) and the tab-separated Netscape format that cookie
 * exporters produce.
 */
export interface ParsedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds. Absent means the exporter did not say. */
  expires?: number;
}

export function parseCookies(raw: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;

    if (text.includes('\t')) {
      // domain, includeSubdomains, path, secure, expiry, name, value
      const parts = text.split('\t');
      const [domain, , path, , expiry, name, value] = parts;
      if (name && value) {
        const seconds = Number(expiry);
        out.push({
          name,
          value,
          domain: domain || '.waze.com',
          path: path || '/',
          expires: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
        });
      }
      continue;
    }
    // Header form carries no domain or expiry, so both are supplied later.
    for (const pair of text.split(';')) {
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (name && value) out.push({ name, value, domain: '.waze.com', path: '/' });
    }
  }
  return out;
}

/**
 * Watch the page's own network traffic for live-map responses.
 *
 * Bodies have to be pulled on `loadingFinished` — before that the response is
 * still streaming, and some time after it the buffer is evicted and the call
 * fails.
 */
function watchGeorss(page: Page, capture: Capture, log: (msg: string) => void): void {
  const wanted = new Map<string, string>();

  page.on('Network.responseReceived', (params) => {
    const p = params as { requestId: string; response?: { url?: string; status?: number } };
    const url = p.response?.url ?? '';
    if (!url.includes(GEORSS)) return;
    capture.requested = true;
    const status = p.response?.status ?? 0;
    capture.statuses.set(status, (capture.statuses.get(status) ?? 0) + 1);
    if (status === 200) wanted.set(p.requestId, url);
  });

  page.on('Network.loadingFinished', (params) => {
    const { requestId } = params as { requestId: string };
    if (!wanted.has(requestId)) return;
    wanted.delete(requestId);
    void page
      .send('Network.getResponseBody', { requestId })
      .then((res) => {
        const { body, base64Encoded } = res as { body: string; base64Encoded: boolean };
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        capture.feeds.push(JSON.parse(text) as WazeFeed);
      })
      .catch((err: Error) => log('  waze: could not read a response body - ' + err.message));
  });
}

function liveMapUrl(lat: number, lon: number, zoom: number): string {
  return `https://www.waze.com/live-map/?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=${zoom}`;
}

/** Every host the site actually sets its cookies on. */
const WAZE_HOSTS = ['.waze.com', 'waze.com', 'www.waze.com'];

/**
 * Load a saved session into the profile before the map asks for one.
 *
 * Two things here are not obvious and both stopped the login sticking.
 *
 * A cookie set without `expires` is a *session* cookie, discarded the moment the
 * browser closes. That is why a sign-in never survived to the next run, however
 * valid the values were.
 *
 * And the site sets its own copies of these names on `www.waze.com` while we
 * were writing ours to `.waze.com`. Both then exist, the host-specific one wins,
 * and the profile's own signed-out session quietly shadowed the one being
 * loaded. So the old copies are deleted from every host variant first.
 */
async function applyCookies(page: Page, cookie: string, log: (msg: string) => void): Promise<void> {
  const cookies = parseCookies(cookie);
  if (cookies.length === 0) {
    log('  waze: cookie setting is present but nothing parsed out of it');
    return;
  }

  for (const name of new Set(cookies.map((c) => c.name))) {
    for (const domain of WAZE_HOSTS) {
      try {
        await page.send('Network.deleteCookies', { name, domain, path: '/' });
      } catch {
        // Nothing there to delete.
      }
    }
  }

  const defaultExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
  await page.send('Network.setCookies', {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: true,
      sameSite: 'Lax',
      expires: c.expires ?? defaultExpiry,
    })),
  });

  // Report what actually stuck rather than what we asked for; a rejected cookie
  // fails silently, which is exactly the failure being chased here.
  const held = (await page.send('Network.getCookies', { urls: ['https://www.waze.com/'] })) as {
    cookies: { name: string; domain: string; expires: number }[];
  };
  const wanted = new Set(cookies.map((c) => c.name));
  const landed = held.cookies.filter((c) => wanted.has(c.name));
  const persistent = landed.filter((c) => c.expires > 0).length;
  log(
    `  waze: applied ${cookies.length} cookie${cookies.length === 1 ? '' : 's'}, ` +
    `${landed.length} present (${persistent} persistent)`
  );
  for (const name of wanted) {
    if (!landed.some((c) => c.name === name)) log(`  waze: ${name} was rejected by the browser`);
  }
}

/**
 * Has the site replaced the pasted session with one of its own?
 *
 * Waze issues a `Set-Cookie` for `_web_session` on `www.waze.com` while the page
 * loads. A host cookie beats a domain cookie, so that copy wins over one written
 * to `.waze.com` — and if the values differ, the pasted session was not accepted
 * and the window is browsing signed out no matter what was pasted. Usually that
 * means the export is stale, or was taken from a browser that was not signed in.
 */
async function sessionWasReplaced(page: Page, cookie: string, log: (msg: string) => void): Promise<void> {
  const wanted = parseCookies(cookie).find((c) => c.name === '_web_session');
  if (!wanted) return;
  try {
    const held = (await page.send('Network.getCookies', { urls: ['https://www.waze.com/'] })) as {
      cookies: { name: string; value: string; domain: string }[];
    };
    const host = held.cookies.find((c) => c.name === '_web_session' && !c.domain.startsWith('.'));
    if (host && host.value !== wanted.value) {
      log('  waze: the site issued its own _web_session, replacing the pasted one -');
      log('  waze: that export is stale or was taken signed out. Use "Sign in to Waze" instead;');
      log('  waze: the session is now kept in the profile across runs.');
    }
  } catch {
    // Not worth failing a pass over a diagnostic.
  }
}

/**
 * Open the live map and wait while the user signs in.
 *
 * Does nothing but wait: Waze's own form is right there, the QR code works with
 * the phone app, and neither the password nor the scan passes through this code.
 * Whatever session results lands in the persistent profile.
 *
 * Worth being clear about what this achieves, because it is not what it looks
 * like. Being signed in does not make the live-map API answer — those requests
 * carry no cookies at all, so there is nothing for a session to attach to. It is
 * kept because it costs nothing, because a signed-in profile is the right state
 * to be in if any of this changes, and because it is the user's own account to
 * use as they see fit.
 */
export async function signInToWaze(
  opts: WazeBrowserOptions, log: (msg: string) => void = () => {}
): Promise<{ signedIn: boolean; message: string }> {
  const holdMs = opts.holdMs ?? 180_000;
  const browser = await openBrowser({
    browserPath: opts.browserPath,
    headless: false,
    profileDir: opts.profileDir,
  });
  let page: Page | null = null;
  const capture: Capture = { feeds: [], statuses: new Map(), requested: false };
  try {
    page = await browser.newPage();
    await page.send('Network.enable');
    if (opts.cookie) await applyCookies(page, opts.cookie, log);
    watchGeorss(page, capture, log);

    await page.goto(liveMapUrl(-33.4193, 149.5775, 13), { waitMs: 6000 });
    log('  waze: sign in in the window - QR code or password, whichever you prefer');
    log(`  waze: waiting up to ${Math.round(holdMs / 1000)}s`);

    // Stops early if the API ever starts answering, which is the only proof
    // that would actually count.
    const until = Date.now() + holdMs;
    while (Date.now() < until) {
      if (capture.statuses.get(200)) break;
      await sleep(2000);
    }
  } finally {
    await page?.close();
    await browser.close();
  }

  const ok = Boolean(capture.statuses.get(200));
  return {
    signedIn: ok,
    message: ok
      ? 'Signed in and the live map is answering. The session is kept for later passes.'
      : 'Session saved to the profile, but the live map still returns 403 - expected, ' +
        'since it sends these requests without cookies. Nothing else to do here.',
  };
}

/**
 * One pass over an area. Returns the same shape as the direct transport, so the
 * pipeline does not care which one produced the observations.
 */
export async function scrapeWazeViaBrowser(
  area: Area, opts: WazeBrowserOptions, log: (msg: string) => void = () => {}
): Promise<WazeResult> {
  const zoom = opts.zoom ?? 13;
  const waitMs = opts.waitMs ?? 9000;
  const holdMs = opts.holdMs ?? 0;
  const maxViews = Math.max(1, opts.maxViews ?? 4);

  // One viewport usually covers a city-sized area; larger ones get panned.
  const views = tileBbox(area.bbox, VIEW_SPAN_DEG).map(bboxCentre).slice(0, maxViews);
  if (views.length === 0) views.push(bboxCentre(area.bbox));

  const collector = new WazeCollector(area, opts);
  const capture: Capture = { feeds: [], statuses: new Map(), requested: false };

  const browser = await openBrowser({
    browserPath: opts.browserPath,
    headless: opts.headless ?? false,
    profileDir: opts.profileDir,
  });
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.send('Network.enable');
    if (opts.cookie) await applyCookies(page, opts.cookie, log);
    watchGeorss(page, capture, log);

    for (const [i, view] of views.entries()) {
      await page.goto(liveMapUrl(view.lat, view.lon, zoom), { waitMs });
      log(`  waze: view ${i + 1}/${views.length} - ${capture.feeds.length} response(s) so far`);
    }
    if (opts.cookie) await sessionWasReplaced(page, opts.cookie, log);

    // Hold the window open so the user can sign in, pan or zoom. Everything the
    // map fetches while they do lands in the same capture.
    if (holdMs > 0) {
      log(`  waze: holding the window open for ${Math.round(holdMs / 1000)}s`);
      const until = Date.now() + holdMs;
      while (Date.now() < until) await sleep(1000);
    }
  } finally {
    await page?.close();
    await browser.close();
  }

  for (const feed of capture.feeds) collector.add(feed);

  const refused = [...capture.statuses.entries()].filter(([status]) => status !== 200);
  let blocked: string | null = null;
  if (!capture.requested) {
    blocked = 'the live map never requested georss - the page may not have loaded';
  } else if (capture.feeds.length === 0 && refused.length > 0) {
    const codes = refused.map(([status, n]) => `HTTP ${status} x${n}`).join(', ');
    blocked =
      `Waze refused the live map's own requests (${codes}). The page sends a valid ` +
      'reCAPTCHA token and it is scored and rejected; cookies are not sent at all, ' +
      'so no login changes this. Nothing here can fix it without bypassing the check.';
  }
  if (blocked) log('  waze: ' + blocked);

  return {
    observations: collector.observations,
    summary: {
      tiles: views.length,
      tilesAttempted: views.length,
      tilesFailed: refused.reduce((n, [, count]) => n + count, 0),
      jams: collector.jams,
      alerts: collector.alerts,
      users: collector.users,
      blocked,
    },
  };
}
