import { config } from './config.js';
import { BlockedError, fetchPage, FetchError, permitted } from './fetch.js';
import { eventsFromHtml } from './extract/jsonld.js';
import { crawlableLinks, feedsFrom } from './extract/links.js';
import { Interest, seedFrom } from './seeds.js';
import * as store from './store.js';
import { isSkippedHost, siteOf } from './urls.js';

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

/** Areas event-scout has asked about. Its Settings are the configuration. */
let interests: Interest[] = [];
export function rememberInterest(interest: Interest): void {
  if (!interest.city.trim()) return;
  const key = interest.city.trim().toLowerCase();
  interests = [interest, ...interests.filter((i) => i.city.trim().toLowerCase() !== key)].slice(0, 12);
}
export const knownInterests = (): Interest[] => interests;

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

    const queued = store.countPages().queued ?? 0;
    if (queued < config.maxPagesPerRun && interests.length) {
      report.seeded = await seedFrom(interests, log);
      log(`  seeded ${report.seeded} new pages from ${interests.length} area(s)`);
    }

    const perSite = new Map<string, number>();
    while (report.fetched + report.failed + report.blocked < config.maxPagesPerRun) {
      const cooling = store.sitesOnCooldown(config.minHostDelayMs, config.maxHostDelayMs);
      const batch = store.nextBatch(config.concurrency, cooling);
      if (batch.length === 0) {
        // Either the frontier is empty or every site with work is resting.
        if ((store.countPages().queued ?? 0) === 0) break;
        await new Promise((r) => setTimeout(r, config.minHostDelayMs));
        continue;
      }
      // Counted only for what is actually fetched. Counting the whole batch
      // and then filtering on the count charged sites for pages that were
      // never requested, and a busy site would exhaust its budget without
      // having been read.
      const taking = batch.filter((item) => {
        const site = siteOf(item.url);
        if ((perSite.get(site) ?? 0) >= config.maxPagesPerSite) return false;
        perSite.set(site, (perSite.get(site) ?? 0) + 1);
        return true;
      });
      if (taking.length === 0) break;
      await Promise.all(taking.map((item) => crawlOne(item.url, item.depth, report, perSite)));
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
