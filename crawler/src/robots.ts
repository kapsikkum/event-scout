/**
 * robots.txt, parsed and obeyed.
 *
 * The one part of a crawler that is not optional. event-scout's own websearch
 * pass never needed this — thirty pages a cycle, all of them handed over by a
 * search engine — but something that follows its own links at hundreds of pages
 * an hour is a different animal, and a crawler that ignores robots.txt gets its
 * address blocked and has earned it.
 *
 * Pure: parsing is separated from fetching so the rules can be tested without a
 * network, which is most of what can be got wrong here.
 */

/** A parsed robots.txt, reduced to what this crawler acts on. */
export interface RobotsRules {
  /** Path rules for the group that matched us, longest-match-wins. */
  rules: { allow: boolean; path: string }[];
  /** Seconds the file asks us to wait between requests, if it said. */
  crawlDelay: number | null;
  /** Sitemaps named in the file. Free seeds, and the reason to keep them. */
  sitemaps: string[];
}

export const EMPTY_RULES: RobotsRules = { rules: [], crawlDelay: null, sitemaps: [] };

/**
 * Parse robots.txt for one user-agent.
 *
 * Groups are keyed by `User-agent`, and consecutive agent lines share the
 * following rules — the shape almost every real file uses and the one most
 * naive parsers get wrong. A named match beats `*`, which is why both are
 * collected and chosen between at the end rather than stopping at the first.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const wanted = userAgent.toLowerCase();
  const groups = new Map<string, { allow: boolean; path: string }[]>();
  const delays = new Map<string, number>();
  const sitemaps: string[] = [];

  // Agents named by the group currently being read. Reset when a rule line
  // arrives, so the next `User-agent` after a rule starts a new group rather
  // than joining the last one.
  let agents: string[] = [];
  let collecting = false;

  for (const line of text.split(/\r?\n/)) {
    // Everything after # is a comment, including mid-line.
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const colon = clean.indexOf(':');
    if (colon < 0) continue;
    const field = clean.slice(0, colon).trim().toLowerCase();
    const value = clean.slice(colon + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // A new agent line after rules means a new group.
      if (collecting) {
        agents = [];
        collecting = false;
      }
      if (value) agents.push(value.toLowerCase());
      continue;
    }
    if (agents.length === 0) continue;

    if (field === 'allow' || field === 'disallow') {
      collecting = true;
      // "Disallow:" with nothing after it means "nothing is disallowed", which
      // is the opposite of "Disallow: /" and must not be treated as a rule.
      if (field === 'disallow' && value === '') continue;
      for (const agent of agents) {
        const list = groups.get(agent) ?? [];
        list.push({ allow: field === 'allow', path: value });
        groups.set(agent, list);
      }
      continue;
    }
    if (field === 'crawl-delay') {
      collecting = true;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        for (const agent of agents) delays.set(agent, seconds);
      }
    }
  }

  // Our own name first: a file that singles us out has said something more
  // specific than its catch-all, and the catch-all no longer applies.
  const key = groups.has(wanted) || delays.has(wanted) ? wanted : '*';
  return {
    rules: groups.get(key) ?? [],
    crawlDelay: delays.get(key) ?? null,
    sitemaps,
  };
}

/**
 * Turn a robots path pattern into a matcher.
 *
 * `*` stands for any run of characters and `$` anchors the end; everything else
 * is literal, so the regex metacharacters in a path — `.` and `?` are common in
 * real files — have to be escaped or they would match far more than intended.
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/**
 * Whether a path may be fetched.
 *
 * Longest match wins, and Allow beats Disallow at equal length — the rule
 * Google and the RFC both settled on, and what lets a site disallow a whole
 * tree and then re-open one page inside it.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules.rules) {
    if (!matches(rule.path, path)) continue;
    if (
      best === null ||
      rule.path.length > best.length ||
      (rule.path.length === best.length && rule.allow)
    ) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best ? best.allow : true;
}
