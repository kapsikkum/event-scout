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

/** A picture on the homeserver, as an m.image event wants it. */
export interface MatrixPicture {
  uri: string;
  mimetype: string;
  size: number;
}

export interface MatrixContent {
  msgtype: 'm.text' | 'm.notice' | 'm.image';
  body: string;
  format?: 'org.matrix.custom.html';
  formatted_body?: string;
  /** m.image: the picture on the homeserver, and what it is. */
  url?: string;
  info?: { mimetype: string; size: number };
  'm.mentions'?: { room?: boolean; user_ids?: string[] };
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const HTML = 'org.matrix.custom.html' as const;
const MUTED = '#98a1b3';

/** "today", "tomorrow", "in 3 days", "in 2 weeks"; '' once the day has gone. */
export function relativeDay(iso: string, now: Date): string {
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(iso)) - day(now)) / 86400_000);
  if (days < 0) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return days < 14 ? `in ${days} days` : `in ${Math.round(days / 7)} weeks`;
}

const hexFor = (category: string): string => `#${colourFor(category).toString(16).padStart(6, '0')}`;

function changesOf(item: NoticeItem): { text: string[]; html: string[] } {
  const list = item.changes ?? [];
  return {
    text: list.map((c) => `✎ ${CHANGE_LABEL[c.field]}: ${c.before ? `${c.before} → ` : ''}${c.after || '(removed)'}`),
    html: list.map(
      (c) => `✎ <b>${CHANGE_LABEL[c.field]}:</b> ${c.before ? `<del>${escapeHtml(c.before)}</del> → ` : ''}${escapeHtml(c.after || '(removed)')}`
    ),
  };
}

/**
 * One event as a line: the date first, since that is what a list is scanned
 * by, then the title and the place. `n` numbers it for the commands that
 * refer back to a list.
 */
export function matrixLine(item: NoticeItem, appUrl: string, n?: number): { text: string; html: string } {
  const ev = readable(item.ev);
  const link = linkFor(ev, appUrl);
  const when = whenText(ev.startTime, ev.dateOnly);
  const where = whereText(ev);
  const again = item.moreDates ? ` (+${item.moreDates} more date${item.moreDates === 1 ? '' : 's'})` : '';
  const title = escapeHtml(cut(ev.title, 140));
  const changes = changesOf(item);
  return {
    text:
      `${n != null ? `${n}. ` : ''}${cut(ev.title, 140)} — ${when} · ${where}${again}${link ? ` ${link}` : ''}` +
      changes.text.map((c) => `\n   ${c}`).join(''),
    html:
      `${n != null ? `<code>${n}</code> ` : ''}<b>${escapeHtml(when)}</b> · ` +
      `${link ? `<a href="${escapeHtml(link)}">${title}</a>` : title} · ` +
      `<font data-mx-color="${MUTED}">${escapeHtml(where)}${escapeHtml(again)}</font>` +
      changes.html.map((c) => `<br>&nbsp;&nbsp;${c}`).join(''),
  };
}

/** A heading and a list of events, one line each, as one message. */
export function matrixList(
  heading: string, items: NoticeItem[], appUrl: string,
  opts: { numbered?: boolean; more?: number; mention?: string } = {}
): MatrixContent {
  const lines = items.map((item, i) => matrixLine(item, appUrl, opts.numbered ? i + 1 : undefined));
  const more = opts.more ? `…and ${opts.more} more` : '';
  const ping = opts.mention === '@room';
  return {
    msgtype: 'm.text',
    body: [`${ping ? '@room ' : ''}${heading}`, ...lines.map((l) => l.text), more].filter(Boolean).join('\n'),
    format: HTML,
    formatted_body:
      `<p>${ping ? '@room ' : ''}<b>${escapeHtml(heading)}</b></p>` +
      (lines.length ? `<p>${lines.map((l) => l.html).join('<br>')}</p>` : '') +
      (more ? `<p><i>${escapeHtml(more)}</i></p>` : ''),
    // Said outright, so a title that happens to contain someone's name pings nobody.
    'm.mentions': ping ? { room: true } : {},
  };
}

/**
 * One event as a card, the way a Discord embed shows it: the title as a link,
 * when and where, the blurb as a quote, and the details in a small muted line
 * after a mark in the category's colour.
 */
export function matrixCard(item: NoticeItem, appUrl: string, now = new Date()): MatrixContent {
  const ev = readable(item.ev);
  const link = linkFor(ev, appUrl);
  const own = appLink(ev, appUrl);
  const when = whenText(ev.startTime, ev.dateOnly);
  const soon = relativeDay(ev.startTime, now);
  const where = whereText(ev);
  const again = item.moreDates ? `↻ and ${item.moreDates} more date${item.moreDates === 1 ? '' : 's'}` : '';
  const blurb = ev.description ? cut(ev.description, 300) : '';
  const details = [ev.category, ev.priceText, ev.photoScore > 0 ? `📷 ${Math.round(ev.photoScore)}` : ''].filter(Boolean);
  const changes = changesOf(item);
  const title = escapeHtml(cut(ev.title, 200));
  const extraLink = own && own !== link ? own : '';

  const html = [
    `<h4>${link ? `<a href="${escapeHtml(link)}">${title}</a>` : title}</h4>`,
    `<p>📅 <b>${escapeHtml(when)}</b>${soon ? ` <font data-mx-color="${MUTED}">· ${soon}</font>` : ''}<br>` +
      `📍 ${escapeHtml(where)}${again ? `<br>${escapeHtml(again)}` : ''}` +
      changes.html.map((c) => `<br>${c}`).join('') +
      `</p>`,
    blurb ? `<blockquote>${escapeHtml(blurb)}</blockquote>` : '',
    details.length || extraLink
      ? `<p><font data-mx-color="${hexFor(ev.category)}">■</font> <font data-mx-color="${MUTED}">${escapeHtml(details.join(' · '))}` +
        `${extraLink ? `${details.length ? ' · ' : ''}<a href="${escapeHtml(extraLink)}">Open in Event Scout</a>` : ''}</font></p>`
      : '',
  ].join('');
  const text = [
    ev.title,
    `📅 ${when}${soon ? ` · ${soon}` : ''}`,
    `📍 ${where}`,
    again,
    ...changes.text,
    blurb,
    details.join(' · '),
    link,
  ].filter(Boolean).join('\n');
  return { msgtype: 'm.text', body: text, format: HTML, formatted_body: html, 'm.mentions': {} };
}

/** A picture as its own message, which clients show at a sensible size with a way to open it. */
export function matrixImage(picture: MatrixPicture, title: string): MatrixContent {
  return { msgtype: 'm.image', body: cut(title, 100), url: picture.uri, info: { mimetype: picture.mimetype, size: picture.size } };
}

/** One line of facts under a title: when, where, category, price. */
function factsOf(ev: MergedEvent): string {
  return [whenText(ev.startTime, ev.dateOnly), whereText(ev), ev.category, ev.priceText].filter(Boolean).join(' · ');
}

/** Minimal: the title in bold as a link, one plain line of facts under it, a blank line between events. */
function minimalBody(notice: Notice, appUrl: string, ping: boolean): MatrixContent {
  const blocks = notice.items.map((item) => {
    const ev = readable(item.ev);
    const link = linkFor(ev, appUrl);
    const title = escapeHtml(cut(ev.title, 200));
    const again = item.moreDates ? ` · ↻ +${item.moreDates} more date${item.moreDates === 1 ? '' : 's'}` : '';
    const changes = changesOf(item);
    return {
      text: [ev.title, factsOf(ev) + again, ...changes.text, link].filter(Boolean).join('\n'),
      html:
        `<p><b>${link ? `<a href="${escapeHtml(link)}">${title}</a>` : title}</b><br>${escapeHtml(factsOf(ev) + again)}` +
        changes.html.map((c) => `<br>${c}`).join('') + '</p>',
    };
  });
  const more = notice.more ? `…and ${notice.more} more` : '';
  return {
    msgtype: 'm.text',
    body: [`${ping ? '@room ' : ''}${notice.heading}`, ...blocks.map((b) => b.text), more].filter(Boolean).join('\n\n'),
    format: HTML,
    formatted_body: `<p>${ping ? '@room ' : ''}<b>${escapeHtml(notice.heading)}</b></p>${blocks.map((b) => b.html).join('')}${more ? `<p><i>${escapeHtml(more)}</i></p>` : ''}`,
    'm.mentions': ping ? { room: true } : {},
  };
}

/** Table: a row an event. Tidy on a desktop client; the plain body is what a phone may show instead. */
function tableBody(notice: Notice, appUrl: string, ping: boolean): MatrixContent {
  const rows = notice.items.map((item) => {
    const ev = readable(item.ev);
    const link = linkFor(ev, appUrl);
    const title = escapeHtml(cut(ev.title, 120));
    const changes = changesOf(item);
    return {
      text: `${whenText(ev.startTime, ev.dateOnly)} — ${ev.title} — ${whereText(ev)}${ev.category ? ` — ${ev.category}` : ''}`,
      html:
        `<tr><td>${escapeHtml(whenText(ev.startTime, ev.dateOnly))}</td>` +
        `<td>${link ? `<a href="${escapeHtml(link)}">${title}</a>` : title}${item.moreDates ? ` (+${item.moreDates})` : ''}${changes.html.map((c) => `<br>${c}`).join('')}</td>` +
        `<td>${escapeHtml(whereText(ev))}</td><td>${escapeHtml(ev.category)}</td></tr>`,
    };
  });
  const more = notice.more ? `…and ${notice.more} more` : '';
  return {
    msgtype: 'm.text',
    body: [`${ping ? '@room ' : ''}${notice.heading}`, ...rows.map((r) => r.text), more].filter(Boolean).join('\n'),
    format: HTML,
    formatted_body:
      `<p>${ping ? '@room ' : ''}<b>${escapeHtml(notice.heading)}</b></p>` +
      (rows.length
        ? `<table><thead><tr><th>When</th><th>Event</th><th>Where</th><th>Category</th></tr></thead><tbody>${rows.map((r) => r.html).join('')}</tbody></table>`
        : '') +
      (more ? `<p><i>${escapeHtml(more)}</i></p>` : ''),
    'm.mentions': ping ? { room: true } : {},
  };
}

/** Plain: no markup at all, so every client shows it the same. */
function plainBody(notice: Notice, appUrl: string, ping: boolean): MatrixContent {
  const blocks = notice.items.map((item) => {
    const ev = readable(item.ev);
    return [ev.title, `${whenText(ev.startTime, ev.dateOnly)} — ${whereText(ev)}`, ...changesOf(item).text, linkFor(ev, appUrl)]
      .filter(Boolean).join('\n');
  });
  return {
    msgtype: 'm.text',
    body: [`${ping ? '@room ' : ''}${notice.heading}`, ...blocks, notice.more ? `…and ${notice.more} more` : ''].filter(Boolean).join('\n\n'),
    'm.mentions': ping ? { room: true } : {},
  };
}

/**
 * A notice as the messages a target asks for, in the room's look.
 *
 *   cards    a heading, then a card for each event and its flyer as an image
 *   minimal  one message, a bold title and a line of facts an event, then the flyers
 *   table    one message with a table; no pictures
 *   plain    one message of plain text; no pictures
 *
 * A digest in the cards look comes as minimal lines: a card each is too much
 * for a list of the week. Quiet targets send notices, which clients draw
 * greyed out and do not alert for; the rest send ordinary messages.
 */
export function matrixMessages(
  notice: Notice, target: NotifyTarget, appUrl: string, pictures: Record<string, MatrixPicture> = {}, now = new Date()
): MatrixContent[] {
  const quiet = (c: MatrixContent): MatrixContent =>
    target.matrixLoud || c.msgtype === 'm.image' ? c : { ...c, msgtype: 'm.notice' };
  const ping = target.mention === '@room';
  const look = notice.kind === 'digest' && target.matrixLook === 'cards' ? 'minimal' : target.matrixLook;
  const flyers = (): MatrixContent[] =>
    target.showImage
      ? notice.items.flatMap((item) => {
          const picture = pictures[item.ev.imageUrl];
          return picture ? [matrixImage(picture, readable(item.ev).title)] : [];
        })
      : [];

  if (look === 'table') return [quiet(tableBody(notice, appUrl, ping))];
  if (look === 'plain') return [quiet(plainBody(notice, appUrl, ping))];
  if (look === 'minimal') return [quiet(minimalBody(notice, appUrl, ping)), ...flyers()];

  const out: MatrixContent[] = [
    quiet({
      msgtype: 'm.text',
      body: `${ping ? '@room ' : ''}${notice.heading}`,
      format: HTML,
      formatted_body: `${ping ? '@room ' : ''}<b>${escapeHtml(notice.heading)}</b>`,
      'm.mentions': ping ? { room: true } : {},
    }),
  ];
  for (const item of notice.items) {
    out.push(quiet(matrixCard(item, appUrl, now)));
    const picture = target.showImage ? pictures[item.ev.imageUrl] : undefined;
    if (picture) out.push(matrixImage(picture, readable(item.ev).title));
  }
  if (notice.more) out.push(quiet({ msgtype: 'm.text', body: `…and ${notice.more} more` }));
  return out;
}

/**
 * A model's answer, which comes as Markdown, as a Matrix message.
 *
 * Only the handful of things a chat answer uses: paragraphs, line breaks,
 * bullet and numbered lines, **bold**, *italic*, `code`, fenced code and
 * [links](https://…). Everything is escaped first, so nothing the model says
 * can become markup it did not mean.
 */
export function markdownToMatrix(md: string): MatrixContent {
  const text = md.replace(/\r\n/g, '\n').trim();
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const parts = text.split(/```[^\n]*\n?/);
  const html = parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`;
      return part
        .split(/\n{2,}/)
        .map((para) => para.trim())
        .filter(Boolean)
        .map((para) => {
          const lines = para.split('\n').map((line) => {
            const heading = /^#{1,6}\s+(.*)$/.exec(line);
            if (heading) return `<b>${inline(heading[1])}</b>`;
            const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
            if (bullet) return `• ${inline(bullet[1])}`;
            return inline(line);
          });
          return `<p>${lines.join('<br>')}</p>`;
        })
        .join('');
    })
    .join('');
  return { msgtype: 'm.text', body: text, format: HTML, formatted_body: html, 'm.mentions': {} };
}

/** Plain words, for a command's reply. */
export function matrixText(text: string): MatrixContent {
  return { msgtype: 'm.text', body: text };
}
