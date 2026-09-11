import { eventLikeness, isSkippedHost, normalizeUrl, sameSite } from '../urls.js';

/**
 * What else on a page is worth fetching.
 *
 * The whole difference between this and event-scout's existing websearch pass.
 * That one parses the page a search engine handed it and stops; a venue's
 * "what's on" links to thirty individual events, and those are where the detail
 * lives. One hop from a page that actually produced an event is where nearly
 * all the yield is, which is why depth is capped rather than unbounded.
 */

/** Every href on a page, normalised and absolute. */
export function linksFrom(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    const url = normalizeUrl(href, pageUrl);
    if (url) out.add(url);
  }
  return [...out];
}

/**
 * The links worth queueing, best first.
 *
 * Same site only. Following off-site links is how a crawler becomes a crawl of
 * the entire web: the seeds decide which sites are in scope, and a page's own
 * links decide which of its pages are.
 */
export function crawlableLinks(html: string, pageUrl: string, limit = 40): { url: string; score: number }[] {
  const scored = linksFrom(html, pageUrl)
    .filter((url) => url !== pageUrl && sameSite(url, pageUrl) && !isSkippedHost(url))
    .map((url) => ({ url, score: eventLikeness(url) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Calendar feeds a page advertises.
 *
 * The best thing a crawler can find. A feed is structured, carries a real
 * timezone rather than a floating string, and one URL replaces crawling the
 * whole site — event-scout already reads iCal, so a discovered feed can simply
 * be handed over.
 */
export function feedsFrom(html: string, pageUrl: string): string[] {
  const out = new Set<string>();

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type\s*=\s*["']text\/calendar["']/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const url = href && normalizeUrl(href, pageUrl);
    if (url) out.add(url);
  }
  // Plenty of calendar plugins never declare the feed and only link it, so the
  // extension is worth trusting where the declaration is missing.
  for (const url of linksFrom(html, pageUrl)) {
    if (/\.ics(\?|$)/i.test(url) || /[?&]ical=1/i.test(url) || /\/\?ical=/i.test(url)) out.add(url);
  }
  return [...out];
}
