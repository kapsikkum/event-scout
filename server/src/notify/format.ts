import type { MergedEvent } from '../events.js';
import type { NotifyTarget } from '../sources/types.js';
import { cleanDescription } from '../validate.js';

/**
 * What a notification says, for Discord and for Matrix.
 *
 * One notice — a heading and the events under it — rendered two ways: Discord
 * embeds, with times as Discord timestamps so each reader sees their own
 * clock, and a Matrix message with plain and HTML bodies. Pure, so the limits
 * each service enforces can be tested without either.
 */

export type NoticeKind = 'new' | 'digest' | 'reminder' | 'change' | 'test';

export interface Change {
  field: 'title' | 'start' | 'end' | 'venue' | 'address';
  before: string;
  after: string;
}

export interface NoticeItem {
  ev: MergedEvent;
  /** Other dates of the same series folded into this one. */
  moreDates?: number;
  changes?: Change[];
}

export interface Notice {
  kind: NoticeKind;
  heading: string;
  items: NoticeItem[];
  /** Matching events left out to keep the message a sensible size. */
  more?: number;
}

const CHANGE_LABEL: Record<Change['field'], string> = {
  title: 'Name', start: 'Starts', end: 'Ends', venue: 'Venue', address: 'Address',
};

/**
 * An event's words as a reader should see them.
 *
 * Titles and venues are stored as the source wrote them, entities and all —
 * "Father&#8217;s Day Out" — and the web page decodes them as it draws. A
 * message is drawn by Discord or a Matrix client, which do not, so it is done
 * here.
 */
export function readable(ev: MergedEvent): MergedEvent {
  return {
    ...ev,
    title: cleanDescription(ev.title),
    description: cleanDescription(ev.description),
    venueName: cleanDescription(ev.venueName),
    address: cleanDescription(ev.address),
    locality: cleanDescription(ev.locality),
    place: cleanDescription(ev.place),
    priceText: cleanDescription(ev.priceText),
  };
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const isHttp = (url: string): boolean => /^https?:\/\/\S+$/i.test(url);

/** The listing's own page, or failing that this app's view of it. */
export function linkFor(ev: MergedEvent, appUrl: string): string {
  return ev.sources.find((s) => isHttp(s.url))?.url ?? appLink(ev, appUrl);
}

export function appLink(ev: MergedEvent, appUrl: string): string {
  const base = appUrl.trim().replace(/\/+$/, '');
  return isHttp(base) ? `${base}/events?event=${encodeURIComponent(ev.group)}` : '';
}

/** Where, in words: the venue, then the town it rounds to when that adds something. */
export function whereText(ev: MergedEvent): string {
  if (ev.isOnline) return 'Online';
  const spot = ev.venueName || ev.address || ev.locality;
  if (!spot) return ev.place || 'Unknown location';
  return ev.place && !spot.toLowerCase().includes(ev.place.toLowerCase()) ? `${spot} (${ev.place})` : spot;
}

/** When, in the server's own zone, for places that cannot render a timestamp. */
export function whenText(iso: string, dateOnly: boolean): string {
  const at = new Date(iso);
  const day = at.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  return dateOnly ? day : `${day}, ${at.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`;
}

const PALETTE = [0xf5a623, 0x4cc3ff, 0x4ade80, 0xf87171, 0xc084fc, 0xfb923c, 0x2dd4bf, 0xe879f9];
/** The same colour for a category everywhere it is shown, as on the calendar. */
export function colourFor(category: string): number {
  let hash = 0;
  for (const ch of category) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

// --- Discord -------------------------------------------------------------------

const unix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
function discordWhen(ev: MergedEvent): string {
  const t = unix(ev.startTime);
  return ev.dateOnly ? `<t:${t}:D>` : `<t:${t}:F> · <t:${t}:R>`;
}

interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
}

function sourcesText(ev: MergedEvent): string {
  return [...new Set(ev.sources.map((s) => s.source))].join(' · ');
}

function eventEmbed(item: NoticeItem, target: NotifyTarget, appUrl: string): Embed {
  const ev = readable(item.ev);
  const full = target.style === 'full';
  const link = linkFor(ev, appUrl);
  const own = appLink(ev, appUrl);
  const lines = [`📅 ${discordWhen(ev)}`, `📍 ${whereText(ev)}`];
  if (item.moreDates) lines.push(`↻ and ${item.moreDates} more date${item.moreDates === 1 ? '' : 's'}`);
  for (const c of item.changes ?? []) {
    lines.push(`✎ **${CHANGE_LABEL[c.field]}:** ${c.before ? `~~${cut(c.before, 120)}~~ → ` : ''}${cut(c.after || '(removed)', 120)}`);
  }
  if (full && ev.description) lines.push('', cut(ev.description, 300));
  if (own && own !== link) lines.push('', `[Open in Event Scout](${own})`);

  const embed: Embed = {
    title: cut(ev.title, 256),
    ...(link ? { url: link } : {}),
    description: cut(lines.join('\n'), 4000),
    color: colourFor(ev.category),
    footer: { text: cut(sourcesText(ev), 200) },
  };
  if (full) {
    const fields: Embed['fields'] = [];
    if (ev.category) fields.push({ name: 'Category', value: cut(ev.category, 100), inline: true });
    if (ev.photoScore > 0) fields.push({ name: '📷 Photo score', value: String(Math.round(ev.photoScore)), inline: true });
    if (ev.priceText) fields.push({ name: 'Price', value: cut(ev.priceText, 100), inline: true });
    if (fields.length) embed.fields = fields;
  }
  if (target.showImage && isHttp(ev.imageUrl) && !ev.imageUrl.includes('/api/flyer/')) {
    if (full) embed.image = { url: ev.imageUrl };
    else embed.thumbnail = { url: ev.imageUrl };
  }
  return embed;
}

/** A digest is a list, one line an event, split across embeds as the limits require. */
function digestEmbeds(notice: Notice, appUrl: string): Embed[] {
  const lines = notice.items.map((item) => {
    const ev = readable(item.ev);
    const { moreDates } = item;
    const link = linkFor(ev, appUrl);
    const title = link ? `[${cut(ev.title, 90).replace(/[[\]]/g, '')}](${link})` : cut(ev.title, 90);
    const again = moreDates ? ` · ↻ +${moreDates}` : '';
    return `**${ev.dateOnly ? `<t:${unix(ev.startTime)}:d>` : `<t:${unix(ev.startTime)}:f>`}** ${title} — ${cut(whereText(ev), 60)}${again}`;
  });
  if (notice.more) lines.push(`…and ${notice.more} more`);
  const embeds: Embed[] = [];
  let chunk: string[] = [];
  for (const line of lines) {
    if ([...chunk, line].join('\n').length > 3900) {
      embeds.push({ description: chunk.join('\n'), color: 0xf5a623 });
      chunk = [];
    }
    chunk.push(line);
  }
  if (chunk.length || embeds.length === 0) embeds.push({ description: chunk.join('\n') || 'Nothing coming up that matches.', color: 0xf5a623 });
  return embeds;
}

const embedSize = (e: Embed): number =>
  (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) +
  (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/**
 * The webhook bodies for a notice: ten embeds and about six thousand
 * characters a message at most, which is what Discord accepts.
 */
export function discordPayloads(notice: Notice, target: NotifyTarget, appUrl: string): Record<string, unknown>[] {
  const embeds = notice.kind === 'digest' ? digestEmbeds(notice, appUrl) : notice.items.map((i) => eventEmbed(i, target, appUrl));
  const mention = target.mention;
  const ping = mention === '@here' || mention === '@everyone' ? mention : mention ? `<@&${mention}>` : '';
  const more = notice.more && notice.kind !== 'digest' ? ` (and ${notice.more} more)` : '';
  const content = cut(`${ping ? `${ping} ` : ''}${notice.heading}${more}`, 1900);
  const base: Record<string, unknown> = {
    allowed_mentions: {
      parse: mention === '@here' || mention === '@everyone' ? ['everyone'] : [],
      roles: /^\d+$/.test(mention) ? [mention] : [],
    },
    ...(target.username ? { username: cut(target.username, 80) } : {}),
    ...(isHttp(target.avatarUrl) ? { avatar_url: target.avatarUrl } : {}),
  };

  const out: Record<string, unknown>[] = [];
  let batch: Embed[] = [];
  let size = content.length;
  for (const embed of embeds) {
    if (batch.length === 10 || size + embedSize(embed) > 5800) {
      out.push({ ...base, embeds: batch });
      batch = [];
      size = 0;
    }
    batch.push(embed);
    size += embedSize(embed);
  }
  out.push({ ...base, embeds: batch });
  // The heading, and the ping with it, only on the first message.
  out[0] = { ...out[0], content };
  return out;
}

// --- Matrix ----------------------------------------------------------------------

export interface MatrixContent {
  msgtype: 'm.text' | 'm.notice';
  body: string;
  format?: 'org.matrix.custom.html';
  formatted_body?: string;
  'm.mentions'?: { room?: boolean; user_ids?: string[] };
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** One event as a line, plain and HTML. `n` numbers it, for the commands that refer back. */
export function matrixLine(
  item: NoticeItem, appUrl: string, n?: number, opts: { full?: boolean; image?: string } = {}
): { text: string; html: string } {
  const ev = readable(item.ev);
  const link = linkFor(ev, appUrl);
  const when = whenText(ev.startTime, ev.dateOnly);
  const where = whereText(ev);
  const again = item.moreDates ? ` (+${item.moreDates} more date${item.moreDates === 1 ? '' : 's'})` : '';
  const num = n != null ? `${n}. ` : '';
  const changes = (item.changes ?? []).map((c) => ({
    text: `${CHANGE_LABEL[c.field]}: ${c.before ? `${c.before} → ` : ''}${c.after || '(removed)'}`,
    html: `<br>✎ <b>${CHANGE_LABEL[c.field]}:</b> ${c.before ? `<del>${escapeHtml(c.before)}</del> → ` : ''}${escapeHtml(c.after || '(removed)')}`,
  }));
  const title = escapeHtml(cut(ev.title, 140));
  const details = opts.full
    ? [ev.category, ev.priceText, ev.photoScore > 0 ? `📷 ${Math.round(ev.photoScore)}` : ''].filter(Boolean).join(' · ')
    : '';
  const blurb = opts.full && ev.description ? cut(ev.description, 280) : '';
  return {
    text:
      `${num}${cut(ev.title, 140)} — ${when} · ${where}${again}${link ? ` ${link}` : ''}` +
      `${changes.map((c) => `\n   ✎ ${c.text}`).join('')}${details ? `\n   ${details}` : ''}${blurb ? `\n   ${blurb}` : ''}`,
    html:
      `${num}${link ? `<a href="${escapeHtml(link)}">${title}</a>` : `<b>${title}</b>`} — ${escapeHtml(when)} · ${escapeHtml(where)}${escapeHtml(again)}` +
      `${changes.map((c) => c.html).join('')}${details ? `<br><i>${escapeHtml(details)}</i>` : ''}${blurb ? `<br>${escapeHtml(blurb)}` : ''}` +
      `${opts.image ? `<br><img src="${escapeHtml(opts.image)}" alt="" height="220">` : ''}`,
  };
}

export interface MatrixListOptions {
  numbered?: boolean;
  more?: number;
  /** The details and blurb under each event, as Discord's full style has. */
  full?: boolean;
  /** Pictures already uploaded to the homeserver (mxc://), by the event's own image address. */
  images?: Record<string, string>;
  /** An ordinary message, which notifies, rather than a quiet bot notice. */
  loud?: boolean;
  /** '@room' pings everyone in the room. */
  mention?: string;
}

/** A heading and a list of events, as one Matrix message. */
export function matrixList(heading: string, items: NoticeItem[], appUrl: string, opts: MatrixListOptions = {}): MatrixContent {
  const lines = items.map((item, i) =>
    matrixLine(item, appUrl, opts.numbered ? i + 1 : undefined, { full: opts.full, image: opts.images?.[item.ev.imageUrl] })
  );
  const more = opts.more ? `…and ${opts.more} more` : '';
  const ping = opts.mention === '@room';
  return {
    msgtype: opts.loud ? 'm.text' : 'm.notice',
    body: [`${ping ? '@room ' : ''}${heading}`, ...lines.map((l) => `• ${l.text}`), more].filter(Boolean).join('\n'),
    format: 'org.matrix.custom.html',
    formatted_body:
      `<p>${ping ? '@room ' : ''}<b>${escapeHtml(heading)}</b></p>` +
      (lines.length ? `<ul>${lines.map((l) => `<li>${l.html}</li>`).join('')}</ul>` : '') +
      (more ? `<p>${escapeHtml(more)}</p>` : ''),
    // Said outright, so a title that happens to contain someone's name pings nobody.
    'm.mentions': ping ? { room: true } : {},
  };
}

/** A notice as one Matrix message, in the look the target asks for. */
export function matrixContent(notice: Notice, target: NotifyTarget, appUrl: string, images: Record<string, string> = {}): MatrixContent {
  // A digest is a list to scan; the details are for events being announced.
  const full = target.style === 'full' && notice.kind !== 'digest';
  return matrixList(notice.heading, notice.items, appUrl, {
    more: notice.more,
    full,
    images: full && target.showImage ? images : {},
    loud: target.matrixLoud,
    mention: target.mention,
  });
}

/** Plain words, for a command's reply. */
export function matrixText(text: string): MatrixContent {
  return { msgtype: 'm.notice', body: text };
}
