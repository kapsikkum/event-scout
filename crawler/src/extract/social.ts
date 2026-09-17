import { CrawledEvent } from '../types.js';
import { monthIndex, whenFromText } from '../shared/textWhen.js';
import { tidyFind } from '../tidy.js';
import { linksFrom } from './links.js';

/**
 * Instagram and Facebook, where most small events are only ever announced.
 *
 * A car club, a market or a pub posts the flyer on Instagram and nowhere else,
 * so a crawler that stops at venue websites misses most of them. Both sites
 * say no to crawlers in robots.txt; this crawler reads them anyway, by
 * decision, and says so here rather than pretending otherwise. See readSocial
 * in crawl.ts for how it keeps that slow.
 *
 * Neither publishes event data in a form the JSON-LD reader understands, so
 * each gets its own:
 *
 *   - An Instagram post has no event fields at all. What it has is a caption,
 *     and the caption is where the date is — "Date: 13th Sept, Sunday / Time:
 *     5am meetup". So a post is read for its caption, and becomes an event only
 *     when the caption names a day on or after the day it was posted.
 *   - A Facebook event page does carry the details, in Facebook's own embedded
 *     format, and event-scout already has a parser for it. So the crawler only
 *     notes the links and event-scout reads them.
 *
 * All pure: what a page says, never what to do about it.
 */

export type SocialKind = 'instagram-profile' | 'instagram-post' | 'facebook-event';

export interface SocialLink {
  kind: SocialKind;
  /** The shortcode, the username, or the Facebook event id. */
  id: string;
  /** One spelling per thing, so the same post linked three ways is one row. */
  url: string;
}

/** Sites the crawler itself fetches with a browser's headers. Facebook is read by the app. */
export const SOCIAL_SITES = new Set(['instagram.com']);

/** First path segments on instagram.com that are pages of the site, not accounts. */
const NOT_ACCOUNTS = new Set([
  'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'stories', 'about', 'developer', 'legal',
  'direct', 'web', 'static', 'emails', 'challenge', 'privacy', 'terms', 'directory', 'topics',
]);

export const postUrl = (code: string): string => `https://www.instagram.com/p/${code}/`;

/** Posts older than this are not read: an event they announce is long past. */
export const STALE_POST_DAYS = 60;

const SHORTCODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Instagram's epoch, in milliseconds, for the timestamp in the top bits of a media id. */
const IG_EPOCH = 1314220021721n;

/**
 * When a post was made, from its shortcode alone.
 *
 * The shortcode is the media id in base 64, and the id carries its creation
 * time in the bits above the lowest 23. Worth knowing before fetching: a
 * profile's twelve posts and a search's results include posts from years ago,
 * and the first run spent most of its Instagram budget reading those. Null for
 * a code that does not decode to a plausible time.
 */
export function postTime(code: string): Date | null {
  let id = 0n;
  for (const ch of code) {
    const at = SHORTCODE.indexOf(ch);
    if (at < 0) return null;
    id = id * 64n + BigInt(at);
  }
  const ms = Number((id >> 23n) + IG_EPOCH);
  // Instagram launched in 2010; anything outside then-to-tomorrow is not a time.
  if (!Number.isFinite(ms) || ms < Date.UTC(2010, 0, 1) || ms > Date.now() + 86400_000) return null;
  return new Date(ms);
}

/** What a link to Instagram or Facebook points at, or null when it is neither or neither kind. */
export function socialKind(raw: string): SocialLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|web|business)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'instagram.com') {
    // /p/<code>, /reel/<code>, and /<user>/p/<code>, which is how a post
    // reached from its profile is spelled.
    const at = parts.findIndex((p) => p === 'p' || p === 'reel');
    const code = at >= 0 ? parts[at + 1] : undefined;
    if (code && /^[A-Za-z0-9_-]{5,}$/.test(code)) return { kind: 'instagram-post', id: code, url: postUrl(code) };
    if (parts.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(parts[0]) && !NOT_ACCOUNTS.has(parts[0].toLowerCase())) {
      const user = parts[0].toLowerCase();
      return { kind: 'instagram-profile', id: user, url: `https://www.instagram.com/${user}/` };
    }
    return null;
  }

  if (host === 'facebook.com') {
    const at = parts.indexOf('events');
    const id = at >= 0 ? parts[at + 1] : undefined;
    if (id && /^\d{8,}$/.test(id)) return { kind: 'facebook-event', id, url: `https://www.facebook.com/events/${id}/` };
  }
  return null;
}

/** Every Instagram and Facebook link on a page, one per thing. */
export function socialLinksFrom(html: string, pageUrl: string): SocialLink[] {
  const out = new Map<string, SocialLink>();
  for (const url of linksFrom(html, pageUrl)) {
    const link = socialKind(url);
    if (link) out.set(link.url, link);
  }
  return [...out.values()];
}

// --- reading a page ---------------------------------------------------------

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#039);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A `<meta>` tag's content by name or property, whichever order the attributes come in. */
function meta(html: string, key: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name)\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== key) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (content !== undefined) return decode(content);
  }
  return undefined;
}


export interface InstagramPost {
  code: string;
  url: string;
  author: string;
  /** The day it was posted, which is what a caption's "Saturday the 13th" is relative to. */
  postedAt: Date | null;
  caption: string;
  imageUrl?: string;
}

/**
 * `100 likes, 5 comments - mqautomotivesociety on September 4, 2026: "…".`
 *
 * The meta description rather than the embedded JSON: the page carries the
 * captions of related posts as well, and the first caption in the JSON was a
 * different post's. The description is only ever this one's, and in full.
 */
const DESCRIPTION = /([A-Za-z0-9._]+) on ([A-Z][a-z]+) (\d{1,2}), (\d{4})(?:: "([\s\S]*)")?\.?\s*$/;

/** A post's caption, author and date, or null when the page did not carry them. */
export function instagramPost(html: string, code: string): InstagramPost | null {
  const description = meta(html, 'description') ?? meta(html, 'og:description');
  if (!description) return null;
  const m = DESCRIPTION.exec(description);
  if (!m) return null;
  const month = monthIndex(m[2]);
  const postedAt = month === undefined ? null : new Date(Number(m[4]), month, Number(m[3]));
  return {
    code,
    url: postUrl(code),
    author: m[1],
    postedAt,
    caption: (m[5] ?? '').trim(),
    imageUrl: meta(html, 'og:image'),
  };
}

/** The recent posts a profile page lists: twelve, logged out. */
export function instagramProfilePosts(html: string, limit = 12): string[] {
  const codes = new Set<string>();
  for (const m of html.matchAll(/"code":"([A-Za-z0-9_-]{8,})"/g)) codes.add(m[1]);
  for (const m of html.matchAll(/\/p\/([A-Za-z0-9_-]{8,})\//g)) codes.add(m[1]);
  return [...codes].slice(0, limit);
}

/**
 * A title from the caption's first line that has words in it, hashtags and
 * emoji dropped.
 *
 * A post has no title field, and its first line is as often a paragraph as a
 * name, so a long one gives only its first sentence — "Cars and Coffee is back
 * at Penrith this Sunday!" rather than the whole invitation after it. The model
 * pass renames it properly later; this is what the card says until then.
 */
export function titleOf(post: InstagramPost): string {
  for (const line of post.caption.split('\n')) {
    const text = line
      .replace(/#[\p{L}\p{N}_]+/gu, '')
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 4) continue;
    const sentence = text.length > 60
      ? (/^(.{12,}?(?<!\b(?:St|Rd|Dr|Mt|Ave|No|vs))[.!?])(?:\s|$)/u.exec(text)?.[1] ?? text)
      : text;
    return sentence.length > 80 ? `${sentence.slice(0, 77).replace(/\s+\S*$/, '')}…` : sentence;
  }
  return `${post.author} on Instagram`;
}

/**
 * An event out of a post, or null when the caption names no date to hold it to.
 *
 * No venue and no town: a caption says "Mount Panorama" or "before the
 * Bathurst 1000" in a sentence, not a field, and a guess at either is worse
 * than a blank. event-scout's model reads the place out of the caption, and
 * one it cannot place shows as Unknown location.
 */
export function eventFromPost(post: InstagramPost, now = new Date()): CrawledEvent | null {
  if (!post.caption) return null;
  const when = whenFromText(post.caption, post.postedAt, now);
  if (!when) return null;
  return tidyFind({
    sourceId: `instagram:${post.code}`,
    title: titleOf(post),
    description: post.caption,
    startTime: when.startTime,
    dateOnly: when.dateOnly,
    url: post.url,
    imageUrl: post.imageUrl,
    foundAt: now.toISOString(),
    foundOn: post.url,
  }, now);
}
