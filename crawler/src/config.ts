import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * How the crawler is set up.
 *
 * Environment only, and every value has a working default, so the container
 * needs no configuration to start. What to look for comes from event-scout at
 * request time rather than from here — it already knows the areas and the
 * topics, and two places to configure the same thing is one too many.
 */
export const config = {
  port: int('CRAWLER_PORT', 3002),

  /**
   * Off unless asked for. The toggle that matters is event-scout's own source
   * switch, which decides whether anything ever asks for these events; this one
   * exists so the container can be left running and idle.
   */
  enabled: process.env.CRAWLER_ENABLED !== 'false',

  dataDir: process.env.CRAWLER_DATA ?? path.resolve(__dirname, '../data'),

  /**
   * Named honestly, with a link, because that is the deal: a site owner who
   * wants this gone can say so in robots.txt and be obeyed, and one who wants
   * to ask about it can find out who to ask.
   */
  userAgent:
    process.env.CRAWLER_UA ??
    'event-scout-crawler/0.3 (+https://github.com/kapsikkum/event-scout)',

  /** Pages per cycle. The budget, and the thing to raise once it behaves. */
  maxPagesPerRun: int('CRAWLER_MAX_PAGES', 300),
  /** How far from a seed to follow links. Two is a hub and its listings. */
  maxDepth: int('CRAWLER_MAX_DEPTH', 2),
  /** Pages from any one site per cycle, so a big calendar cannot eat the budget. */
  maxPagesPerSite: int('CRAWLER_MAX_PER_SITE', 40),
  /** Simultaneous fetches across all sites. Per-site is always one. */
  concurrency: int('CRAWLER_CONCURRENCY', 4),
  /** Floor on the gap between two requests to the same site, milliseconds. */
  minHostDelayMs: int('CRAWLER_HOST_DELAY_MS', 1500),
  /** Ceiling on what a site's own Crawl-delay can ask of us, milliseconds. */
  maxHostDelayMs: int('CRAWLER_MAX_HOST_DELAY_MS', 30000),

  requestTimeoutMs: int('CRAWLER_TIMEOUT_MS', 15000),
  /** Largest page worth reading. Well past any real one. */
  maxBytes: int('CRAWLER_MAX_BYTES', 3 * 1024 * 1024),

  /** Minutes between cycles. */
  intervalMinutes: int('CRAWLER_INTERVAL_MIN', 30),

  /** How long a find is offered before it is dropped, days. */
  keepFindsDays: int('CRAWLER_KEEP_DAYS', 45),

  /**
   * Whether to read Instagram, and to note Facebook events for the app.
   *
   * Both sites' robots.txt say no to every crawler, and this crawler obeys
   * robots.txt everywhere else. It reads these two anyway because most small
   * events are only ever posted there — a decision, set here so it can be
   * undone without a rebuild. See extract/social.ts.
   */
  social: process.env.CRAWLER_SOCIAL !== 'false',
  /** Instagram pages per cycle. Low, so an address that reads too much is not flagged. */
  maxSocialPerCycle: int('CRAWLER_SOCIAL_PER_CYCLE', 20),
  /** Gap between two Instagram requests, milliseconds. A person scrolling, not a scraper. */
  socialDelayMs: int('CRAWLER_SOCIAL_DELAY_MS', 8000),
};

export function ensureDataDir(): string {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return config.dataDir;
}
