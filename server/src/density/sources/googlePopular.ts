import { Browser, Page, openBrowser } from '../cdp.js';
import { sleep } from '../http.js';
import { inBbox } from '../geo.js';
import { loadVenues, recordPanelChecks, replaceVenues, saveVenues, Venue, WeekProfile, Observation } from '../store.js';
import type { Area, DensityConfig } from '../areas.js';
import { BROWSER_HEADERS } from '../../useragent.js';


/**
 * Live venue busyness from the Google Maps "Popular times" panel.
 *
 * This is the only source that measures *presence* — how full a place is right
 * now — rather than inferring it from congestion, which is what actually
 * locates a gathering. It reads the rendered page rather than the internal
 * `/maps/preview/place` endpoint: that endpoint is protobuf-encoded and bound
 * to a short-lived session token, whereas these aria-labels have been stable
 * for years.
 *
 * Note this reads the Maps UI, which Google's terms of service do not permit.
 * Keep the venue count and cadence modest.
 */

export const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/**
 * Pull name, feature id, knowledge-graph mid and coordinates out of a place
 * link.
 *
 * The mid arrives two ways. Links scraped out of a search result page carry it
 * literally as `!16s/m/086s43`; links Google hands a person — the address bar,
 * or a maps.app.goo.gl share link once resolved — carry it base64'd as
 * `!16zL20vMDg2czQz`. Reading only the first form is why a pasted link used to
 * be rejected.
 */
export function parsePlaceLink(href: string): Omit<Venue, 'term' | 'profile'> | null {
  const url = decodeURIComponent(href);
  const name = /\/maps\/place\/([^/]+)\//.exec(url)?.[1]?.replace(/\+/g, ' ');
  const cid = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(url)?.[1];
  const lat = Number(/!3d(-?[\d.]+)/.exec(url)?.[1]);
  const lon = Number(/!4d(-?[\d.]+)/.exec(url)?.[1]);
  // The mid is not optional: without it Google cannot resolve the place and
  // silently redirects to a generic map with no panel at all.
  let kgmid = /!16s([^!?]+)/.exec(url)?.[1] ?? null;
  const encoded = /!16z([A-Za-z0-9_-]+)/.exec(url)?.[1];
  if (!kgmid && encoded) {
    try {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      if (/^\/[a-z]\/[\w]+$/i.test(decoded)) kgmid = decoded;
    } catch {
      // Not base64 after all; treated as a link without a mid.
    }
  }
  if (!name || !cid || !kgmid || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { name, cid, kgmid, lat, lon };
}

/**
 * Resolve a place a user pasted, whether it is a full Maps URL or one of the
 * short maps.app.goo.gl share links.
 *
 * Naming a place by link is the only unambiguous way to pin one. A search for
 * "Mount Panorama" returns the mountain, the reserve and the circuit, and the
 * one carrying popular times is not reliably the first — so a search term
 * cannot say which of them was meant, and a link can.
 */
export async function resolvePlaceUrl(link: string): Promise<Omit<Venue, 'term' | 'profile'> | null> {
  const direct = parsePlaceLink(link);
  if (direct) return direct;
  try {
    const res = await fetch(link, { redirect: 'follow', headers: BROWSER_HEADERS });
    // Only the final URL is wanted; the body is a consent page as often as not.
    await res.arrayBuffer().catch(() => undefined);
    return res.url && res.url !== link ? parsePlaceLink(res.url) : null;
  } catch {
    return null;
  }
}

/** A pinned place written as a link rather than a search term. */
export function isPlaceLink(entry: string): boolean {
  return /^https?:\/\//i.test(entry.trim());
}

/** Build the place URL that actually renders the popular-times panel. */
export function placeUrl(v: Pick<Venue, 'name' | 'cid' | 'kgmid' | 'lat' | 'lon'>): string {
  const slug = encodeURIComponent(v.name.replace(/ /g, '+')).replace(/%2B/g, '+');
  return `https://www.google.com/maps/place/${slug}/data=!4m6!3m5!1s${v.cid}` +
    `!8m2!3d${v.lat}!4d${v.lon}!16s${encodeURIComponent(v.kgmid)}`;
}

/**
 * Runs inside the page. Returns raw label strings only — every regex lives in
 * Node. A pattern written inside this template string is not the pattern you
 * think it is: `\d` collapses to a literal `d` and silently matches nothing.
 */
export const EXTRACT_JS = `(() => {
  const labels = [...document.querySelectorAll('[aria-label*="busy"]')].map(e => e.getAttribute('aria-label'));
  const bars = [...document.querySelectorAll('[aria-label*="busy at"]')];
  if (bars.length === 0) return JSON.stringify({ labels, dayLabels: null, dayGroups: 0 });

  // Climb from the first bar until an ancestor holds every bar. Deriving the
  // root this way avoids depending on Google's wrapper markup, which varies
  // between venues - a fixed selector matched some pages and missed others.
  let root = bars[0];
  while (root.parentElement && root.querySelectorAll('[aria-label*="busy at"]').length < bars.length) {
    root = root.parentElement;
  }

  // Then descend while one child still holds them all. Where they finally split
  // is the day level: seven siblings in calendar order from Sunday, and a day
  // the venue is closed is present but empty.
  let node = root;
  for (let d = 0; d < 8; d++) {
    const carrier = [...node.children].find(
      (k) => k.querySelectorAll('[aria-label*="busy at"]').length === bars.length
    );
    if (!carrier) break;
    node = carrier;
  }

  const days = [...node.children].map((child) =>
    [...child.querySelectorAll('[aria-label*="busy at"]')].map((e) => e.getAttribute('aria-label'))
  );
  return JSON.stringify({ labels, dayLabels: days.length === 7 ? days : null, dayGroups: days.length });
})()`;

/**
 * A pause either side of `mean`, rather than the same pause every time.
 *
 * A fixed interval between page loads is a machine signature — no person browses
 * on a metronome — so the delay is spread across roughly ±40% of the mean. The
 * average cadence is unchanged, which is what the politeness budget is about.
 */
export function jitter(mean: number): number {
  return Math.round(mean * (0.6 + Math.random() * 0.8));
}

export type HourPct = [hour: number, pct: number];

/** "64% busy at 7 am." -> [7, 64]. Null for anything unparseable. */
export function parseBusyLabel(label: string | null): HourPct | null {
  const m = /(\d+)%\s+busy\s+at\s+(\d+)\s*(am|pm)/i.exec(label ?? '');
  if (!m) return null;
  let hour = Number(m[2]) % 12;
  if (/pm/i.test(m[3])) hour += 12;
  return [hour, Number(m[1])];
}

/** Seven arrays of raw labels -> seven arrays of [hour, percent]. */
export function parseWeek(dayLabels: (string | null)[][] | null): HourPct[][] | null {
  if (!Array.isArray(dayLabels) || dayLabels.length !== 7) return null;
  return dayLabels.map((day) => (day ?? []).map(parseBusyLabel).filter((x): x is HourPct => x !== null));
}

/**
 * Fold the weekly profile into the headline facts. Daily *totals* decide the
 * busiest day, not the single highest bar, so a venue with one sharp spike
 * doesn't outrank one that is solidly busy all day.
 */
export function summariseWeek(days: HourPct[][] | null): Omit<WeekProfile, 'updatedAt'> | null {
  if (!Array.isArray(days) || days.length !== 7) return null;
  const totals = days.map((d) => d.reduce((sum, [, pct]) => sum + pct, 0));
  const open = totals.map((t, i) => ({ i, t })).filter((x) => x.t > 0);
  if (open.length === 0) return null;

  const busiest = open.reduce((a, x) => (x.t > a.t ? x : a));
  const quietest = open.reduce((a, x) => (x.t < a.t ? x : a));
  const peak = days[busiest.i].reduce((a, x) => (x[1] > a[1] ? x : a), days[busiest.i][0]);

  return {
    busiestDay: DAY_NAMES[busiest.i],
    busiestDayIndex: busiest.i,
    busiestHour: peak[0],
    busiestPeak: peak[1],
    quietestDay: DAY_NAMES[quietest.i],
    openDays: open.map((x) => DAY_NAMES[x.i]),
    byDay: Object.fromEntries(
      days.map((d, i) => [DAY_NAMES[i], Object.fromEntries(d.map(([h, p]) => [String(h), p]))])
    ),
  };
}

/**
 * The live reading, plus the typical value for each hour.
 * "Currently 0% busy, usually 50% busy." is the real-time one.
 */
export function parseBusyLabels(labels: (string | null)[]): {
  live: number | null; typicalNow: number | null; byHour: Record<number, number>;
} {
  const byHour = new Map<number, number>();
  let live: number | null = null;
  let typicalNow: number | null = null;

  for (const label of labels) {
    const now = /Currently\s+(\d+)%\s+busy,\s+usually\s+(\d+)%\s+busy/i.exec(label ?? '');
    if (now) {
      live = Number(now[1]);
      typicalNow = Number(now[2]);
      continue;
    }
    const at = parseBusyLabel(label);
    if (at) byHour.set(at[0], Math.max(byHour.get(at[0]) ?? 0, at[1]));
  }
  return { live, typicalNow, byHour: Object.fromEntries(byHour) };
}

/**
 * Trim to `limit` by taking one venue from each search term in turn. Slicing
 * the raw list instead lets the first few terms eat the whole quota — cafes and
 * pubs crowding out the car parks and lookouts that actually signal a gathering.
 */
export function balanceByTerm<T extends { term: string }>(venues: T[], limit: number): T[] {
  const byTerm = new Map<string, T[]>();
  for (const v of venues) {
    if (!byTerm.has(v.term)) byTerm.set(v.term, []);
    byTerm.get(v.term)!.push(v);
  }
  const queues = [...byTerm.values()];
  const out: T[] = [];
  let drained = false;
  while (out.length < limit && !drained) {
    drained = true;
    for (const queue of queues) {
      if (queue.length === 0) continue;
      out.push(queue.shift()!);
      drained = false;
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * A browser that survives one of its pages wedging.
 *
 * A page occasionally stops answering CDP entirely — `Runtime.evaluate` times
 * out — and that can take the whole browser with it, so the next `newPage()`
 * fails with "fetch failed" and the rest of the pass is lost. That was survivable
 * when the venue list was capped at 30; uncapped it is not, since one bad page
 * an hour into a run would throw away everything gathered so far. Relaunching is
 * cheap and the profile is persistent, so nothing is lost by doing it.
 */
class BrowserSession {
  private browser: Browser | null = null;
  private launches = 0;

  constructor(private cfg: DensityConfig, private log: (msg: string) => void) {}

  async page(): Promise<Page> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.browser) {
        this.browser = await openBrowser({
          browserPath: this.cfg.browserPath,
          headless: this.cfg.headless,
          profileDir: this.cfg.profileDir,
        });
        if (++this.launches > 1) this.log(`  browser restarted (${this.launches} launches this pass)`);
      }
      try {
        return await this.browser.newPage();
      } catch {
        // The browser is gone rather than merely busy; drop it and relaunch.
        await this.close();
      }
    }
    throw new Error('Could not open a page after relaunching the browser');
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Already gone.
      }
    }
  }
}

async function withBrowser<T>(
  cfg: DensityConfig, log: (msg: string) => void, fn: (s: BrowserSession) => Promise<T>
): Promise<T> {
  const session = new BrowserSession(cfg, log);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

export interface DiscoverResult { venues: number; byTerm: Record<string, number> }

/**
 * Find venues inside an area by running Maps searches, then cache them.
 * Kept separate from scraping: the venue list barely changes, while busyness
 * changes constantly.
 */
export async function discoverVenues(
  area: Area, cfg: DensityConfig, log: (msg: string) => void = () => {}
): Promise<DiscoverResult> {
  const centre = {
    lat: (area.bbox.south + area.bbox.north) / 2,
    lon: (area.bbox.west + area.bbox.east) / 2,
  };
  // A pinned place given as a Maps link needs no search at all: the link
  // already identifies exactly one place, which is the whole reason for
  // allowing it. Names still go through search like any other term.
  const pinnedLinks = cfg.places.filter(isPlaceLink);
  const pinnedNames = cfg.places.filter((p) => !isPlaceLink(p));
  const terms = [...pinnedNames, ...cfg.searches];
  const found = new Map<string, Venue>();
  const linked: Venue[] = [];

  for (const link of pinnedLinks) {
    const parsed = await resolvePlaceUrl(link);
    if (!parsed) {
      log(`  pinned link could not be resolved: ${link}`);
      continue;
    }
    if (!inBbox(area.bbox, parsed.lat, parsed.lon)) {
      log(`  pinned ${parsed.name} is outside ${area.name}, skipping`);
      continue;
    }
    linked.push({ ...parsed, term: 'pinned link', profile: null });
    found.set(parsed.cid, linked[linked.length - 1]);
    log(`  pinned link: ${parsed.name}`);
  }

  await withBrowser(cfg, log, async (session) => {
    for (const [i, term] of terms.entries()) {
      let page: Page;
      try {
        page = await session.page();
      } catch (err) {
        log(`  ${term} skipped: ${(err as Error).message}`);
        continue;
      }
      try {
        await page.setUserAgent();
        const url =
          `https://www.google.com/maps/search/${encodeURIComponent(term)}` +
          `/@${centre.lat},${centre.lon},${cfg.searchZoom}z`;
        // Same reasoning as the venue loop: wait for the results to exist
        // rather than for a fixed span, then read them.
        await page.goto(url, { waitMs: 0 });
        await page.waitFor(`document.querySelectorAll('a[href*="/maps/place/"]').length`, {
          timeoutMs: cfg.waitMs,
        });
        const hrefs = JSON.parse(
          (await page.evaluate(
            `JSON.stringify([...document.querySelectorAll('a[href*="/maps/place/"]')].map(a => a.href))`
          )) || '[]'
        ) as string[];

        let added = 0;
        for (const href of hrefs) {
          const parsed = parsePlaceLink(href);
          if (!parsed || found.has(parsed.cid)) continue;
          if (!inBbox(area.bbox, parsed.lat, parsed.lon)) continue;
          found.set(parsed.cid, { ...parsed, term, profile: null });
          added++;
        }
        log(`  ${term}: +${added} (${found.size} total)`);
      } catch (err) {
        log(`  ${term} failed: ${(err as Error).message}`);
      } finally {
        await page.close();
      }
      if (i < terms.length - 1) await sleep(jitter(cfg.requestDelayMs));
    }
  });

  // Pinned places skip the per-term quota but are capped per name, so a broad
  // match ("Mount Panorama" returns five) cannot crowd out every category.
  const all = [...found.values()];
  // Places pinned by link are exact and always kept; pinned names are capped,
  // so a broad match ("Mount Panorama" returns five) cannot crowd out every
  // category.
  const pinned: Venue[] = [...linked];
  for (const name of pinnedNames) {
    pinned.push(...all.filter((v) => v.term === name).slice(0, cfg.placesPerName));
  }
  const rest = balanceByTerm(
    all.filter((v) => !pinned.includes(v)),
    Math.max(0, cfg.maxVenues - pinned.length)
  );
  const venues = [...pinned, ...rest];
  replaceVenues(area.slug, venues);

  const byTerm: Record<string, number> = {};
  for (const v of venues) byTerm[v.term] = (byTerm[v.term] ?? 0) + 1;
  return { venues: venues.length, byTerm };
}

export interface PopularResult {
  observations: Observation[];
  summary: {
    venues: number; withLive: number; withTypical: number;
    profilesUpdated: number; failed: number; quickChecked: number;
  };
}

/**
 * How long to wait for a venue's popular-times panel.
 *
 * Most of a pass used to be spent here. Google publishes no popular times for
 * car parks, sports grounds or small restaurants — roughly half a discovered
 * venue list — and those pages are indistinguishable from a slow one until the
 * timeout expires, so every barren venue cost the full patience every hour and
 * returned nothing, every time.
 *
 * Once a venue has come up empty `BARREN_AFTER` passes running it is treated as
 * having no panel and given only enough time to prove otherwise. It is re-probed
 * with full patience every `REPROBE_EVERY` passes regardless, so a venue that
 * gains popular times later — or was merely having a bad day — is picked back
 * up rather than written off permanently.
 */
const BARREN_AFTER = 3;
const REPROBE_EVERY = 24;
const BARREN_WAIT_MS = 3500;

export function panelWaitMs(venue: Venue, fullMs: number): number {
  const streak = venue.barrenStreak ?? 0;
  if (streak < BARREN_AFTER) return fullMs;
  return streak % REPROBE_EVERY === 0 ? fullMs : BARREN_WAIT_MS;
}

/** Poll every cached venue for its current busyness and weekly profile. */
export async function scrapePopular(
  area: Area, cfg: DensityConfig, log: (msg: string) => void = () => {}
): Promise<PopularResult> {
  // Explicitly pinned places are polled first: the cap below is a cost control,
  // and it should never be what drops the one venue that was asked for by name.
  const venues = loadVenues(area.slug)
    .sort((a, b) => Number(b.term === 'pinned link') - Number(a.term === 'pinned link'))
    .slice(0, cfg.maxVenues);
  if (venues.length === 0) {
    log('  google-popular: no venues cached - run discovery first');
    return {
      observations: [],
      summary: { venues: 0, withLive: 0, withTypical: 0, profilesUpdated: 0, failed: 0, quickChecked: 0 },
    };
  }
  // Barren venues are quick now, so counting them at full cost overstates the
  // wait by minutes; estimate each venue at the patience it will actually get.
  const barren = venues.filter((v) => panelWaitMs(v, cfg.waitMs + 6000) === BARREN_WAIT_MS).length;
  const estMs = venues.reduce(
    (sum, v) => sum + cfg.requestDelayMs + 2000 + panelWaitMs(v, cfg.waitMs + 6000) / 2, 0
  );
  const mins = Math.round(estMs / 60_000);
  log(
    `  google-popular: ${venues.length} venue${venues.length === 1 ? '' : 's'}` +
    (barren ? `, ${barren} with no panel (quick-checked)` : '') +
    (mins >= 2 ? ` (roughly ${mins} min)` : '')
  );

  const observations: Observation[] = [];
  const updated: Venue[] = [];
  const checks: { cid: string; sawPanel: boolean }[] = [];
  let withLive = 0, withTypical = 0, profilesUpdated = 0, failed = 0;
  const hourNow = new Date().getHours();

  await withBrowser(cfg, log, async (session) => {
    for (const [i, venue] of venues.entries()) {
      let page: Page;
      try {
        page = await session.page();
      } catch (err) {
        failed++;
        log(`  ${venue.name} skipped: ${(err as Error).message}`);
        continue;
      }
      try {
        await page.setUserAgent();
        // No fixed settle time: the poll below starts immediately and returns
        // the moment the panel appears, so a flat sleep here would only delay
        // every venue by its length. Mount Panorama takes longer than any flat
        // wait allowed, which is why the panel is waited for rather than timed.
        await page.goto(placeUrl(venue), { waitMs: 0 });
        const sawPanel = await page.waitFor(
          `document.querySelectorAll('[aria-label*="busy"]').length`,
          { timeoutMs: panelWaitMs(venue, cfg.waitMs + 6000) }
        );
        checks.push({ cid: venue.cid, sawPanel });
        const payload = JSON.parse((await page.evaluate(EXTRACT_JS)) || '{}') as {
          labels?: (string | null)[]; dayLabels?: (string | null)[][] | null;
        };
        const { live, typicalNow, byHour } = parseBusyLabels(payload.labels ?? []);

        // The weekly profile is near-static, so it lives on the venue record
        // rather than being copied onto every observation.
        const week = summariseWeek(parseWeek(payload.dayLabels ?? null));
        if (week) {
          venue.profile = { ...week, updatedAt: new Date().toISOString() };
          updated.push(venue);
          profilesUpdated++;
        }

        // Prefer the live reading; fall back to what this hour usually looks
        // like so a quiet venue still contributes a sensible baseline.
        const typical = typicalNow ?? byHour[hourNow] ?? null;
        const pct = live ?? typical;
        if (live != null) withLive++;
        else if (typical != null) withTypical++;
        if (pct == null) continue;

        observations.push({
          source: 'google-popular',
          kind: live != null ? 'live' : 'typical',
          lat: venue.lat,
          lon: venue.lon,
          weight: (pct / 100) * cfg.weight,
          meta: {
            name: venue.name,
            live,
            typical,
            hour: hourNow,
            busiestDay: venue.profile?.busiestDay ?? null,
            busiestHour: venue.profile?.busiestHour ?? null,
          },
        });
      } catch (err) {
        failed++;
        log(`  ${venue.name} failed: ${(err as Error).message}`);
      } finally {
        await page.close();
      }
      if (i < venues.length - 1) await sleep(jitter(cfg.requestDelayMs));
    }
  });

  if (updated.length) saveVenues(area.slug, updated);
  if (checks.length) recordPanelChecks(area.slug, checks);
  return {
    observations,
    summary: {
      venues: venues.length, withLive, withTypical, profilesUpdated, failed,
      quickChecked: barren,
    },
  };
}
