import { config } from './config.js';
import { BlockedError, FetchError, fetchPage, permitted } from './fetch.js';
import {
  eventFromPost, instagramPost, instagramProfilePosts, postUrl, SOCIAL_SITES, SocialLink, socialKind, socialLinksFrom,
  titleOf,
} from './extract/social.js';
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
  // Instagram and Facebook go their own way: see readSocial.
  const social = config.social ? socialKind(url) : null;
  if (social?.kind === 'facebook-event') {
    store.offerSocial(social, url);
    store.markDone(url, 0, 'handed to event-scout');
    return;
  }
  if (social) return crawlSocial(url, social, report);

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

  // Links out to Instagram and Facebook. Off-site, so never followed as the
  // site's own links are, but where most small events are actually announced.
  if (config.social) for (const link of socialLinksFrom(page.html, page.url)) store.offerSocial(link, page.url);

  if (shouldFollow(depth, found.length)) {
    const budget = config.maxPagesPerSite - (perSite.get(site) ?? 0);
    for (const link of crawlableLinks(page.html, page.url).slice(0, Math.max(0, budget))) {
      if (isSkippedHost(link.url)) continue;
      store.offer(link.url, depth + 1, link.score);
    }
  }

  store.markDone(url, found.length);
}

/**
 * One Instagram page, read as a person's browser would read it.
 *
 * robots.txt is not asked: Instagram's says no to every crawler, and reading
 * it anyway is the decision recorded in config.ts. It gets a real browser's
 * headers because without them the page is an empty shell. What keeps this
 * from being a nuisance is pace — one request every CRAWLER_SOCIAL_DELAY_MS,
 * at most CRAWLER_SOCIAL_PER_CYCLE a cycle, profiles once a day and each post
 * only ever once.
 */
async function readSocial(link: SocialLink): Promise<{ events: CrawledEvent[]; posts: number; note: string }> {
  const site = siteOf(link.url);
  store.setHostDelay(site, config.socialDelayMs);
  store.touchHost(site);
  const page = await fetchPage(link.url, { browser: true });

  if (link.kind === 'instagram-profile') {
    const codes = instagramProfilePosts(page.html);
    for (const code of codes) store.offerSocial({ kind: 'instagram-post', id: code, url: postUrl(code) }, link.url);
    return { events: [], posts: codes.length, note: `${codes.length} recent posts` };
  }

  const post = instagramPost(page.html, link.id);
  if (!post) throw new FetchError('no caption on the page; Instagram may be asking for a login');
  const event = eventFromPost(post, new Date(), knownInterests().map((i) => i.city));
  if (event) store.keep(event);
  return { events: event ? [event] : [], posts: 0, note: event ? '' : 'no upcoming date in the caption' };
}

async function crawlSocial(url: string, link: SocialLink, report: CycleReport): Promise<void> {
  try {
    const got = await readSocial(link);
    report.fetched++;
    report.events += got.events.length;
    store.markDone(url, got.events.length, got.note);
  } catch (err) {
    const message = (err as Error).message;
    // A post that is gone is gone; anything else is tried again tomorrow.
    store.markFailed(url, message, err instanceof BlockedError || /HTTP 404/.test(message));
    store.touchHost(siteOf(url), true);
    report.failed++;
    if (report.lines.length < 40) report.lines.push(`  ${url.slice(0, 80)}: ${message}`);
  }
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

    // Instagram profiles once a day, for whatever they have posted since.
    if (config.social) {
      const profiles = store.requeueSocialProfiles(24);
      if (profiles) log(`  ${profiles} Instagram profiles due again`);
    }

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
      const spent = [...perSite]
        .filter(([site, n]) => n >= (SOCIAL_SITES.has(site) ? config.maxSocialPerCycle : config.maxPagesPerSite))
        .map(([site]) => site);
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
    // Written down for the graph. A cycle is not undone by failing to record
    // it, so a database that will not take the row is a line in the log.
    try {
      store.recordCycle(report);
    } catch (err) {
      log(`  could not record the cycle: ${(err as Error).message}`);
    }
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
  /** Times this page has been read, this time included. */
  reads?: number;
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
  const social = config.social ? socialKind(url) : null;
  if (social) return readSocialNow(url, social);
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
  if (config.social) for (const link of socialLinksFrom(page.html, page.url)) store.offerSocial(link, page.url);
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
    reads: store.readsOf(url),
  };
}

/** "Read a page now" for an Instagram or Facebook link: see readSocial. */
async function readSocialNow(url: string, link: SocialLink): Promise<PageReport> {
  const nothing = { events: [] as CrawledEvent[], links: 0, feeds: [] as string[] };
  store.offerSocial(link, url);
  if (link.kind === 'facebook-event') {
    return {
      url: link.url,
      ok: true,
      message: 'A Facebook event. The app reads it with its Facebook reader on its next refresh.',
      ...nothing,
    };
  }
  try {
    const got = await readSocial(link);
    store.markDone(link.url, got.events.length, got.note);
    if (link.kind === 'instagram-profile') {
      return {
        url: link.url,
        ok: true,
        message: `An Instagram profile: ${got.posts} recent post${got.posts === 1 ? '' : 's'} queued for the next cycle.`,
        ...nothing,
        links: got.posts,
        reads: store.readsOf(link.url),
      };
    }
    return {
      url: link.url,
      ok: true,
      message: got.events.length
        ? 'Found an event in the caption.'
        : 'Read the post, but its caption names no date on or after the day it was posted.',
      ...nothing,
      events: got.events,
      reads: store.readsOf(link.url),
    };
  } catch (err) {
    store.markFailed(link.url, (err as Error).message);
    return { url: link.url, ok: false, message: `Could not read it: ${(err as Error).message}`, ...nothing };
  }
}

/** What peekPost hands back: the event if the caption dates it, and the post either way. */
export interface PostPeek {
  ok: boolean;
  message: string;
  events: CrawledEvent[];
  post?: { title: string; caption: string; imageUrl: string; url: string; author: string; postedAt: string | null };
}

/**
 * An Instagram post read for event-scout's "Add from a link", and nothing more.
 *
 * Unlike "Read a page now", nothing is kept and nothing is queued: the person
 * adding it is about to check it by hand, and the app stores what they save.
 * The caption comes back even when it names no date, because the form can take
 * the date from them. Here rather than in the app because this is where
 * Instagram is read with a browser's headers.
 */
export async function peekPost(raw: string): Promise<PostPeek> {
  if (!config.social) return { ok: false, message: 'Reading Instagram is switched off here (CRAWLER_SOCIAL).', events: [] };
  const url = normalizeUrl(raw.trim());
  const link = url ? socialKind(url) : null;
  if (link?.kind !== 'instagram-post') return { ok: false, message: 'Only an Instagram post can be read this way.', events: [] };
  try {
    const page = await fetchPage(link.url, { browser: true });
    const post = instagramPost(page.html, link.id);
    if (!post) return { ok: false, message: 'No caption on the page; Instagram may be asking for a login.', events: [] };
    const event = eventFromPost(post, new Date(), knownInterests().map((i) => i.city));
    return {
      ok: true,
      message: event ? 'Found a date in the caption.' : 'Read the caption, but it names no upcoming date.',
      events: event ? [event] : [],
      post: {
        title: titleOf(post),
        caption: post.caption,
        imageUrl: post.imageUrl ?? '',
        url: post.url,
        author: post.author,
        postedAt: post.postedAt?.toISOString() ?? null,
      },
    };
  } catch (err) {
    return { ok: false, message: `Could not read it: ${(err as Error).message}`, events: [] };
  }
}
