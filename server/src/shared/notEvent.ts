import { cleanLine } from './text.js';

function parseUrlSafely(rawUrl?: string): URL | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    try {
      return new URL(rawUrl, 'https://placeholder.internal');
    } catch {
      return null;
    }
  }
}

function isRootUrl(parsed: URL | null): boolean {
  if (!parsed) return false;
  return parsed.pathname === '/' || parsed.pathname === '';
}

function hasSiteInfoPath(rawUrl?: string, parsed?: URL | null): boolean {
  if (!rawUrl) return false;
  const path = (parsed ? parsed.pathname : rawUrl).toLowerCase();
  return (
    path.includes('/contact') ||
    path.includes('/about-us') ||
    path.includes('/privacy') ||
    path.includes('/terms')
  );
}

const HOMEPAGE_TITLE_PREFIX = /^(?:home\s*[-|–—:]\s*|welcome\s+to\s+|homepage\b)/i;
const HOMEPAGE_LIKE_TITLE = /^(?:home|welcome|main\s+page|official\s+(?:website|site))\b|\bhome$/i;

const SITE_INFO_TITLE =
  /^(?:contact(?:\s+us)?|about(?:\s+us)?|terms(?:\s+and\s+conditions)?|privacy\s+policy)(?:\s*[-|–—:]\s*.*)?$/i;

const VOLUNTEER_TITLE = new RegExp(
  [
    '\\b(?:call\\s+for|become\\s+a)\\s+volunteers?\\b',
    '\\bvolunteers?\\s+(?:application|applications|info|information|registration|register|sign[-\\s]?up|wanted|needed|recruitment|call|resources?|calendar|portal|pack|requirements?)\\b',
    '\\b(?:application|call|wanted|needed|recruiting)\\s+(?:for\\s+)?volunteers?\\b',
    '\\b(?:officials?|marshals?)\\s*(?:&|and|\\/)\\s*volunteers?\\b',
    '\\bvolunteers?\\s*(?:&|and|\\/)\\s*(?:officials?|marshals?)\\b',
    '\\bvolunteering\\s+(?:application|applications|info|resources?|calendar|opportunities|opportunity|portal|pack)\\b',
    '\\bofficials?\\s+applications?\\b',
    '\\bmarshals?\\s+(?:wanted|applications?)\\b',
  ].join('|'),
  'i'
);

const VOLUNTEER_DESC =
  /\b(?:apply\s+to\s+volunteer|volunteer\s+application|looking\s+for\s+volunteers|volunteers?\s+needed|calling\s+all\s+volunteers|join\s+our\s+(?:volunteer\s+)?team|seeking\s+volunteers)\b/i;
const SPECTATOR_DETAILS =
  /\b(?:tickets?|admission|spectators?|doors\s+open|gates\s+open|entry\s+fee|general\s+admission)\b/i;

const VENDOR_TITLE = new RegExp(
  [
    '\\b(?:stallholders?|vendors?|exhibitors?)\\s*(?:applications?|info|information|packages?|forms?|packs?|portals?)?\\b',
    '\\b(?:grants?|scholarships?)\\s*applications?\\b',
    '\\bapplications?\\s+for\\s+(?:grants?|scholarships?)\\b',
  ].join('|'),
  'i'
);

const NEWS_URL = /\/(?:news|blog|press)\//i;
const RECAP_TITLE =
  /\b(?:recap|recaps|results|breakthrough|at\s+odds|health\s+update|clash|clashes|emotional|wrap[-\s]?up|review|highlights|winner|wins|won)\b/i;

/**
 * Detects whether a page, candidate, or crawled event represents a non-event
 * (such as a homepage, site utility page, volunteer recruitment notice,
 * vendor application, or news recap).
 *
 * Returns a human-readable reason string when not an event, or null if it appears to be an event.
 */
export function detectNotAnEvent(
  title?: string,
  description?: string,
  url?: string
): string | null {
  const t = title ? cleanLine(title) : '';
  const desc = description ? cleanLine(description) : '';
  const parsedUrl = parseUrlSafely(url);

  // 1. Homepages & Generic Site Pages
  if (t) {
    if (HOMEPAGE_TITLE_PREFIX.test(t)) {
      return 'homepage';
    }
    if (parsedUrl && isRootUrl(parsedUrl) && HOMEPAGE_LIKE_TITLE.test(t)) {
      return 'homepage';
    }
  }

  // 2. Site Information & Contact Pages
  if (t && SITE_INFO_TITLE.test(t)) {
    return 'site information or contact page';
  }
  if (hasSiteInfoPath(url, parsedUrl)) {
    return 'site information or contact page';
  }

  // 3. Volunteer / Staff Recruitment & Applications
  if (t && VOLUNTEER_TITLE.test(t)) {
    return 'volunteer recruitment or application';
  }
  if (desc && VOLUNTEER_DESC.test(desc) && !SPECTATOR_DETAILS.test(desc)) {
    return 'volunteer recruitment or application';
  }

  // 4. Vendor / Stallholder / Grant Applications
  if (t && VENDOR_TITLE.test(t)) {
    return 'vendor, stallholder or grant application';
  }

  // 5. News Articles / Race Recaps
  if (url && NEWS_URL.test(url) && t && RECAP_TITLE.test(t)) {
    return 'news article or race recap';
  }

  return null;
}
