/**
 * Deciding what a URL is and whether it is worth a fetch.
 *
 * All pure, and all of it is what keeps the crawl finite. A frontier that does
 * not normalise will fetch the same page under five spellings, and one that
 * follows every link will spend its budget on login forms and image galleries.
 */

/** Hosts that never yield JSON-LD worth having, or block scrapers outright. */
const SKIP_HOSTS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'linkedin.com', 'pinterest.com', 'reddit.com',
  'google.com', 'bing.com', 'duckduckgo.com', 'mojeek.com',
];

/** Extensions that are certainly not a page. */
const BINARY = /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|pdf|zip|gz|mp[34]|mov|avi|woff2?|ttf|eot)$/i;

/**
 * Query parameters that never change what a page says.
 *
 * Tracking junk mostly. Dropping it is what stops the same event arriving four
 * times because four sites linked it with four different campaign tags.
 */
const JUNK_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|mc_[ce]id$|ref$|source$|_ga$|igshid$)/i;

/**
 * One spelling per page.
 *
 * Lowercased host, no fragment, no tracking parameters, sorted query, and no
 * trailing slash except at the root. Deliberately keeps meaningful parameters:
 * `?event=123` is a different page and dropping it would lose most of what a
 * calendar plugin publishes.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  // Default ports are noise; leaving them in makes two spellings of one page.
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  const keep = [...url.searchParams.entries()].filter(([k]) => !JUNK_PARAMS.test(k));
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of keep) url.searchParams.append(k, v);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

/** The registrable-ish site, so `www.x.com` and `events.x.com` count as one. */
export function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split('.');
    // Good enough for the two-label and three-label cases this meets in
    // practice (example.com, example.com.au). A public-suffix list would be
    // exact, and is not worth a dependency for deciding crawl politeness.
    const take = parts.length > 2 && parts.at(-2)!.length <= 3 && parts.at(-1)!.length <= 3 ? 3 : 2;
    return parts.slice(-take).join('.');
  } catch {
    return '';
  }
}

export function sameSite(a: string, b: string): boolean {
  const sa = siteOf(a);
  return sa !== '' && sa === siteOf(b);
}

/** Somewhere this crawler should never go, whatever links to it. */
export function isSkippedHost(url: string): boolean {
  const site = siteOf(url);
  return SKIP_HOSTS.includes(site) || BINARY.test(new URL(url).pathname);
}

/**
 * How much a URL looks like it leads to events, from its shape alone.
 *
 * Used to order the frontier rather than to filter it: a wrong guess costs a
 * page, and a page that scores zero is still fetched eventually if there is
 * budget. Ordering is the whole trick, because the budget always runs out
 * before the web does.
 */
export function eventLikeness(url: string): number {
  let score = 0;
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();

  if (/\/(events?|whats-?on|gigs?|calendar|programme?|diary|shows?)(\/|$)/.test(path)) score += 10;
  if (/\/(event|tickets?|festival|markets?|meet|show)/.test(path)) score += 4;
  // A date in the path is the strongest signal a page is one listing, not a hub.
  if (/\/20\d\d[-/]\d{1,2}([-/]\d{1,2})?(\/|$)/.test(path)) score += 6;
  if (/\/(tag|category|author|search|login|signin|register|cart|checkout|account|privacy|terms)(\/|$)/.test(path)) score -= 8;
  if (/\/(page|p)\/\d+/.test(path)) score -= 3;
  // Deep paths are usually an individual page; very deep ones are usually junk.
  const depth = path.split('/').filter(Boolean).length;
  if (depth >= 2 && depth <= 4) score += 2;
  if (depth > 6) score -= 4;
  return score;
}
