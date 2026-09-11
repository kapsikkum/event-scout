import { config } from './config.js';
import { BlockedError, fetchPage, permitted } from './fetch.js';
import { eventsFromHtml } from './extract/jsonld.js';
import { crawlableLinks, feedsFrom } from './extract/links.js';
import { Interest } from './queries.js';
import { seedFrom } from './seeds.js';
import * as store from './store.js';
import { CrawledEvent } from './types.js';
import { isSkippedHost, normalizeUrl, siteOf } from './urls.js';

/**
 * One pass of the crawl.
 *
 * Budgeted rather than exhaustive. The web does not run out, so the only
 * question is what the next few hundred pages are spent on, and the answer is:
 * pages that look like events, on sites that have produced events before,
 * never two at once on the same host.
 */

export interface CycleReport {
  startedAt: string;
  finishedAt: string | null;
  seeded: number;
  fetched: number;
  failed: number;
  blocked: number;
  events: number;
  feeds: number;
  lines: string[];
}

let current: CycleReport | null = null;
let last: CycleReport | null = null;
let running = false;

export const status = () => ({ running, current, last });

/**
 * Where to look, as event-scout last described it.
 *
 * Kept in the database rather than in memory. It used to be learned only when
 * the app asked for events, and forgotten on restart, so a restarted crawler
 * sat idle until the app's next refresh — up to six hours — came round and
 * mentioned an area again.
 */
export const knownInterests = (): Interest[] => store.getJson<Interest[]>('interests', []);
export const setInterests = (list: Interest[]): void => store.setJson('interests', list);

/** Whether there is anything to do: somewhere to search, or pages to read. */
export const hasWork = (): boolean => knownInterests().length > 0 || store.listSeeds().length > 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pages whose links are worth following — a site that has never produced an event still gets one hop. */
function shouldFollow(depth: number, events: number): boolean {
  if (depth >= config.maxDepth) return false;
  // A page that yielded events is a listing worth expanding. A page that did
  // not still gets followed at depth 0, because a site's front page rarely
  // carries the events itself and always links to the page that does.
  return events > 0 || depth === 0;
}

async function crawlOne(
  url: string,
  depth: number,
  report: CycleReport,
  perSite: Map<string, number>
): Promise<void> {
  const site = siteOf(url);
  try {
    if (!(await permitted(url))) {
      store.markFailed(url, 'robots.txt', true);
      report.blocked++;
      return;
    }
  } catch (err) {
    store.markFailed(url, `robots: ${(err as Error).message}`, true);
    report.blocked++;
    return;
  }

  store.touchHost(site);
  let page;
  try {
    page = await fetchPage(url);
  } catch (err) {
    const permanent = err instanceof BlockedError || /HTTP 4\d\d|not html/.test((err as Error).message);
    store.markFailed(url, (err as Error).message, permanent);
    store.touchHost(site, true);
    report.failed++;
    if (report.lines.length < 40) report.lines.push(`  ${url.slice(0, 80)}: ${(err as Error).message}`);
    return;
  }

  const found = eventsFromHtml(page.html, page.url);
  for (const event of found) store.keep(event);
  report.events += found.length;
  report.fetched++;

  for (const feed of feedsFrom(page.html, page.url)) {
    store.rememberFeed(feed, page.url);
    report.feeds++;
  }

  if (shouldFollow(depth, found.length)) {
    const budget = config.maxPagesPerSite - (perSite.get(site) ?? 0);
    for (const link of crawlableLinks(page.html, page.url).slice(0, Math.max(0, budget))) {
      if (isSkippedHost(link.url)) continue;
      store.offer(link.url, depth + 1, link.score);
    }
  }

  store.markDone(url, found.length);
}

export async function runCycle(log: (line: string) => void = () => {}): Promise<CycleReport> {
  if (running) throw new Error('already running');
  running = true;

  const report: CycleReport = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    seeded: 0, fetched: 0, failed: 0, blocked: 0, events: 0, feeds: 0,
    lines: [],
  };
  current = report;

  try {
    // A listing page is never finished: next week it has different events on
    // it. Only pages that produced something are worth revisiting.
    const requeued = store.requeueProductive(20);
    if (requeued) log(`  ${requeued} productive pages due again`);

    // Pinned pages come round every six hours whatever else is queued.
    const pinned = store.requeueSeeds(6);
    if (pinned) log(`  ${pinned} pinned pages due again`);

    const interests = knownInterests();
    const queued = store.countPages().queued ?? 0;
    if (queued < config.maxPagesPerRun && interests.length) {
      report.seeded = await seedFrom(interests, log);
      log(`  seeded ${report.seeded} new pages from ${interests.length} area(s)`);
    }

    const perSite = new Map<string, number>();
    while (report.fetched + report.failed + report.blocked < config.maxPagesPerRun) {
      // Sites that have had their share this cycle are left out of the pick,
      // so a big calendar near the top of the queue cannot stall the rest.
      const spent = [...perSite].filter(([, n]) => n >= config.maxPagesPerSite).map(([site]) => site);
      const cooling = store.sitesOnCooldown(config.minHostDelayMs, config.maxHostDelayMs);
      const batch = store.nextBatch(config.concurrency, [...cooling, ...spent]);
      if (batch.length === 0) {
        // Nothing left but sites that are resting or have had their share.
        // Wait out a rest; stop once only spent sites, or nothing, remain.
        if (store.nextBatch(1, spent).length === 0) break;
        await sleep(config.minHostDelayMs);
        continue;
      }
      for (const item of batch) {
        const site = siteOf(item.url);
        perSite.set(site, (perSite.get(site) ?? 0) + 1);
      }
      await Promise.all(batch.map((item) => crawlOne(item.url, item.depth, report, perSite)));
    }

    const dropped = store.tidyFinds();
    if (dropped) log(`  dropped ${dropped} finds that are now past`);
  } finally {
    report.finishedAt = new Date().toISOString();
    running = false;
    current = null;
    last = report;
  }

  log(
    `  fetched ${report.fetched}, ${report.events} events, ${report.feeds} feeds, ` +
      `${report.failed} failed, ${report.blocked} blocked by robots`
  );
  return report;
}

export interface PageReport {
  url: string;
  finalUrl?: string;
  ok: boolean;
  message: string;
  events: CrawledEvent[];
  links: number;
  feeds: string[];
}

/**
 * Read one page now, outside the cycle, and say what was on it.
 *
 * For an address someone wants checked: a venue they have just found, a link
 * they were sent. The same rules as the crawl — robots.txt, the address check,
 * HTML only — and what it finds is kept exactly as a crawled page's would be.
 * Its links go into the queue, so the rest of the site is followed next cycle
 * without anyone having to pin it.
 *
 * Not held back by the per-site pause. One request a person asked for is not
 * the burst the pause exists to prevent, and making them wait to be told what
 * is on a page would only be irritating.
 */
export async function crawlUrlNow(raw: string): Promise<PageReport> {
  const nothing = { events: [] as CrawledEvent[], links: 0, feeds: [] as string[] };
  const url = normalizeUrl(raw.trim());
  if (!url) return { url: raw, ok: false, message: 'That is not a web address.', ...nothing };
  store.offer(url, 0, store.PINNED_SCORE);

  try {
    if (!(await permitted(url))) {
      store.markFailed(url, 'robots.txt', true);
      return {
        url,
        ok: false,
        message: "That site's robots.txt asks crawlers not to read this page, so it has not been read.",
        ...nothing,
      };
    }
  } catch (err) {
    return { url, ok: false, message: (err as Error).message, ...nothing };
  }

  store.touchHost(siteOf(url));
  let page;
  try {
    page = await fetchPage(url);
  } catch (err) {
    store.markFailed(url, (err as Error).message, err instanceof BlockedError);
    return { url, ok: false, message: `Could not read it: ${(err as Error).message}`, ...nothing };
  }

  const events = eventsFromHtml(page.html, page.url);
  for (const event of events) store.keep(event);
  const feeds = feedsFrom(page.html, page.url);
  for (const feed of feeds) store.rememberFeed(feed, page.url);
  const links = crawlableLinks(page.html, page.url, config.maxPagesPerSite).filter((l) => !isSkippedHost(l.url));
  for (const link of links) store.offer(link.url, 1, link.score);
  store.markDone(url, events.length);

  return {
    url,
    finalUrl: page.url === url ? undefined : page.url,
    ok: true,
    message:
      events.length > 0
        ? `Found ${events.length} event${events.length === 1 ? '' : 's'}.`
        : 'No structured event data on this page itself.',
    events,
    links: links.length,
    feeds,
  };
}
