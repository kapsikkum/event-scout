import { CrawledEvent } from '../types.js';
import { EventWhen, isWorthKeeping } from './when.js';
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

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const monthIndex = (name: string): number | undefined => MONTHS[name.slice(0, 3).toLowerCase()];

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

// --- a date out of a caption ------------------------------------------------

const MON = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
/** "13th Sept", "24th of September 2026". */
const DAY_MONTH = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?[\s,]+(${MON})\b\.?(?:,?\s+(20\d\d))?`, 'gi');
/** "September 24", "Sept 13th, 2026" — but not the 7 in "September 7:30pm", which is a time. */
const MONTH_DAY = new RegExp(String.raw`\b(${MON})\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?![:.]\d|\s*[ap]\.?m\b)(?:,?\s+(20\d\d))?`, 'gi');
/** "12/10/2026", day first, as dates are written here. Only with a year: "1/2" is as often a fraction. */
const NUMERIC = /\b(\d{1,2})\/(\d{1,2})\/(20\d\d|\d\d)\b/g;
/** "7:30PM", "5am", "18:30". */
const CLOCK = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/i;

interface Candidate { index: number; end: number; year: number | null; month: number; day: number }

function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const m of text.matchAll(DAY_MONTH)) {
    if (m[2] === 'may') continue; // "you may", not May
    const month = monthIndex(m[2]);
    if (month !== undefined) found.push({ index: m.index!, end: m.index! + m[0].length, year: m[3] ? Number(m[3]) : null, month, day: Number(m[1]) });
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    if (m[1] === 'may') continue;
    const month = monthIndex(m[1]);
    if (month !== undefined) found.push({ index: m.index!, end: m.index! + m[0].length, year: m[3] ? Number(m[3]) : null, month, day: Number(m[2]) });
  }
  for (const m of text.matchAll(NUMERIC)) {
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    found.push({ index: m.index!, end: m.index! + m[0].length, year, month: Number(m[2]) - 1, day: Number(m[1]) });
  }
  // In reading order, and a date inside one already taken is part of it —
  // "24th September" is not also "September 7".
  found.sort((a, b) => a.index - b.index);
  const kept: Candidate[] = [];
  for (const c of found) {
    const last = kept[kept.length - 1];
    if (last && c.index < last.end) continue;
    kept.push(c);
  }
  return kept;
}

/** A real day, or null: `new Date(2026, 1, 30)` is March, not an error. */
function realDay(year: number, month: number, day: number): Date | null {
  const at = new Date(year, month, day);
  return at.getFullYear() === year && at.getMonth() === month && at.getDate() === day ? at : null;
}

function clock(text: string): { hour: number; minute: number } | null {
  const m = CLOCK.exec(text);
  if (!m) return null;
  if (m[3]) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    return { hour: (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0), minute: Number(m[2] ?? 0) };
  }
  return { hour: Number(m[4]), minute: Number(m[5]) };
}

/**
 * When a caption says the event is.
 *
 * The first date in it that is on or after the day it was posted. A year left
 * out is the one that puts it on or after that day, so a December post about
 * "Jan 10th" means next January. A date more than nine months on is a mention
 * of something past — "back on 30th August" rolls to next August otherwise —
 * and is passed over. The time is the first one after the date, or failing
 * that on a line that says "Time"; with neither it is a date and nothing more.
 */
export function whenFromCaption(caption: string, postedAt: Date | null, now = new Date()): EventWhen | null {
  const posted = postedAt ?? now;
  const postedDay = new Date(posted.getFullYear(), posted.getMonth(), posted.getDate());
  const nineMonths = 270 * 86400000;

  for (const c of candidates(caption)) {
    let at = realDay(c.year ?? postedDay.getFullYear(), c.month, c.day);
    if (!at) continue;
    if (c.year === null && at < postedDay) at = realDay(postedDay.getFullYear() + 1, c.month, c.day);
    if (!at || at < postedDay) continue;
    if (c.year === null && at.getTime() - postedDay.getTime() > nineMonths) continue;

    const time = clock(caption.slice(c.end, c.end + 150)) ?? clock(/\btimes?\b[^\n]{0,40}/i.exec(caption)?.[0] ?? '');
    if (!time) return { startTime: at.toISOString(), dateOnly: true };
    const start = new Date(at.getFullYear(), at.getMonth(), at.getDate(), time.hour, time.minute);
    return { startTime: start.toISOString(), dateOnly: false };
  }
  return relativeWhen(caption, postedDay);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** "tonight", "tomorrow", "this Sunday", "next Saturday", "this weekend". */
const RELATIVE = /\b(tonight|tomorrow|(?:this|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend))\b/i;

/**
 * A day named relative to the day of posting, when the caption gives no date.
 *
 * "Cars and coffee this Sunday from 7am" is how most small meets are
 * announced. "Next Saturday" is read as the coming one, as it usually means in
 * a post; "this weekend" as its Saturday. "Today" is left out — "book today"
 * says nothing about when the event is.
 */
function relativeWhen(caption: string, postedDay: Date): EventWhen | null {
  const m = RELATIVE.exec(caption);
  if (!m) return null;
  const word = m[1].toLowerCase();
  let offset: number;
  if (word === 'tonight') offset = 0;
  else if (word === 'tomorrow') offset = 1;
  else {
    const name = m[2].toLowerCase();
    const target = name === 'weekend' ? 6 : WEEKDAYS.indexOf(name);
    offset = (target - postedDay.getDay() + 7) % 7;
  }
  const at = new Date(postedDay.getFullYear(), postedDay.getMonth(), postedDay.getDate() + offset);
  const end = m.index + m[0].length;
  const time = clock(caption.slice(end, end + 150)) ?? clock(/\btimes?\b[^\n]{0,40}/i.exec(caption)?.[0] ?? '');
  if (!time) return { startTime: at.toISOString(), dateOnly: true };
  return {
    startTime: new Date(at.getFullYear(), at.getMonth(), at.getDate(), time.hour, time.minute).toISOString(),
    dateOnly: false,
  };
}

/** A title from the caption's first line that has words in it, hashtags dropped. */
export function titleOf(post: InstagramPost): string {
  for (const line of post.caption.split('\n')) {
    const text = line.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim();
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 4) continue;
    return text.length > 120 ? `${text.slice(0, 117).replace(/\s+\S*$/, '')}…` : text;
  }
  return `${post.author} on Instagram`;
}

/** "Penrith NSW" is searched for as "Penrith": the region is how the area was typed, not how a caption says it. */
function areaWord(area: string): string {
  return area.split(',')[0].trim().replace(/\s+[A-Z]{2,3}$/, '').trim();
}

/**
 * Which of the areas being searched a piece of text names, if any.
 *
 * A caption has no venue field, but it usually says the town — "our Bathurst
 * drive", "meet at Penrith" — and the areas are the towns this crawl is about,
 * so a mention of one is a place worth geocoding. Matched with its capital, or
 * shouted, so "an orange car" is not Orange but "THIS TIME IS BATHURST" is
 * Bathurst; the first one named wins. The area comes back as it was typed,
 * region and all, since that is what geocodes cleanly.
 */
export function placeFromText(text: string, areas: string[]): string | undefined {
  let best: { at: number; area: string } | undefined;
  for (const area of areas) {
    const word = areaWord(area);
    if (word.length < 3) continue;
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const spelled = `${escape(word)}|${escape(word.toUpperCase())}`;
    const m = new RegExp(`(?<![\\p{L}\\p{N}])(?:${spelled})(?![\\p{L}\\p{N}])`, 'u').exec(text);
    if (m && (!best || m.index < best.at)) best = { at: m.index, area: area.trim() };
  }
  return best?.area;
}

/**
 * An event out of a post, or null when the caption names no date to hold it to.
 *
 * No venue: a caption says "Mount Panorama" in a sentence, not a field, and a
 * guess at one would be worse than a blank. The town is another matter — see
 * placeFromText — and is given as the address when the caption names one of
 * `areas`, so the event lands in that town rather than nowhere.
 */
export function eventFromPost(post: InstagramPost, now = new Date(), areas: string[] = []): CrawledEvent | null {
  if (!post.caption) return null;
  const when = whenFromCaption(post.caption, post.postedAt, now);
  if (!when || !isWorthKeeping(when.startTime, now)) return null;
  const address = placeFromText(post.caption, areas);
  return {
    sourceId: `instagram:${post.code}`,
    title: titleOf(post),
    description: post.caption.slice(0, 4000),
    startTime: when.startTime,
    dateOnly: when.dateOnly,
    ...(address ? { address } : {}),
    url: post.url,
    imageUrl: post.imageUrl,
    foundAt: now.toISOString(),
    foundOn: post.url,
  };
}
