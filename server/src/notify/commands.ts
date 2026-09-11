import type { MergedEvent } from '../events.js';
import { foldSeries } from './run.js';
import { matrixLine, matrixList, matrixText, MatrixContent, whenText, whereText, linkFor, escapeHtml } from './format.js';

/**
 * What the Matrix bot answers.
 *
 *   !help                      what it understands
 *   !events [when] [words…]    what is on: today, tomorrow, weekend, week,
 *                              month or 14d; words narrow it by category or title
 *   !new                       found in the last week
 *   !search <words>            anything upcoming that mentions them
 *   !event <n>                 more about item n of the last list in this room
 *   !star / !unstar / !hide <n>
 *   !digest                    the week ahead
 *   !status                    when it last looked
 *
 * Changing an event is kept to the allowed list; reading is anyone's who can
 * see the room. Lists are numbered, and the numbers stay good for the room
 * until the next list replaces them.
 */

export interface Command {
  name: string;
  args: string[];
}

export function parseCommand(body: string, prefix: string): Command | null {
  const p = prefix || '!';
  const text = body.trim();
  if (!text.startsWith(p)) return null;
  const [name, ...args] = text.slice(p.length).trim().split(/\s+/);
  if (!name || !/^[a-z]+$/i.test(name)) return null;
  return { name: name.toLowerCase(), args };
}

const WINDOWS = ['today', 'tomorrow', 'weekend', 'week', 'month'];

/** The span a word names, from the start of today. */
export function windowFor(word: string | undefined, now: Date): { from: number; to: number; label: string } | null {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (d: number): number => new Date(day.getFullYear(), day.getMonth(), day.getDate() + d).getTime();
  const w = (word ?? 'week').toLowerCase();
  if (w === 'today') return { from: now.getTime() - 3600_000, to: at(1), label: 'today' };
  if (w === 'tomorrow') return { from: at(1), to: at(2), label: 'tomorrow' };
  if (w === 'weekend') {
    const dow = day.getDay();
    const sat = dow === 0 ? -1 : 6 - dow;
    return { from: dow === 0 || dow === 6 ? now.getTime() - 3600_000 : at(sat), to: at(sat + 2), label: 'this weekend' };
  }
  if (w === 'week') return { from: now.getTime() - 3600_000, to: at(7), label: 'in the next 7 days' };
  if (w === 'month') return { from: now.getTime() - 3600_000, to: at(31), label: 'in the next month' };
  const days = /^(\d{1,3})d$/.exec(w);
  if (days) return { from: now.getTime() - 3600_000, to: at(Number(days[1])), label: `in the next ${days[1]} days` };
  return null;
}

export interface CommandDeps {
  events(): MergedEvent[];
  setFlag(group: string, flag: 'starred' | 'hidden', value: boolean): void;
  status(): string;
  allowed(sender: string): boolean;
  appUrl: string;
  prefix: string;
}

const LIST_MAX = 15;
/** Per room: the groups of the last list shown, so "!star 3" means the third of those. */
const lastLists = new Map<string, string[]>();

function list(roomId: string, heading: string, events: MergedEvent[], deps: CommandDeps, empty: string): MatrixContent {
  const items = foldSeries(events);
  if (!items.length) return matrixText(empty);
  const kept = items.slice(0, LIST_MAX);
  lastLists.set(roomId, kept.map((i) => i.ev.group));
  return matrixList(heading, kept, deps.appUrl, { numbered: true, more: items.length - kept.length });
}

function picked(roomId: string, arg: string | undefined, deps: CommandDeps): MergedEvent | string {
  const n = Number(arg);
  const groups = lastLists.get(roomId);
  if (!groups) return `Ask for a list first, e.g. ${deps.prefix}events`;
  if (!Number.isInteger(n) || n < 1 || n > groups.length) return `Pick a number from 1 to ${groups.length}`;
  const ev = deps.events().find((e) => e.group === groups[n - 1]);
  return ev ?? 'That one has gone since the list was made';
}

function help(p: string): MatrixContent {
  const lines = [
    `${p}events [today|tomorrow|weekend|week|month|14d] [words…] — what is on`,
    `${p}new — found in the last week`,
    `${p}search <words> — anything upcoming that mentions them`,
    `${p}event <n> — more about item n of the last list`,
    `${p}star <n>, ${p}unstar <n>, ${p}hide <n> — shortlist or remove it`,
    `${p}digest — the week ahead`,
    `${p}status — when it last looked`,
  ];
  return {
    msgtype: 'm.notice',
    body: `Event Scout\n${lines.join('\n')}`,
    format: 'org.matrix.custom.html',
    formatted_body: `<p><b>Event Scout</b></p><ul>${lines.map((l) => `<li><code>${escapeHtml(l.split(' — ')[0])}</code> — ${escapeHtml(l.split(' — ')[1])}</li>`).join('')}</ul>`,
  };
}

export function runCommand(
  cmd: Command, ctx: { roomId: string; sender: string }, deps: CommandDeps, now = new Date()
): MatrixContent | null {
  const upcoming = (): MergedEvent[] =>
    deps.events().filter((e) => !e.hidden && !e.culled && Date.parse(e.startTime) >= now.getTime() - 3600_000);
  const p = deps.prefix;

  switch (cmd.name) {
    case 'help':
    case 'commands':
      return help(p);

    case 'events':
    case 'digest': {
      const args = cmd.name === 'digest' ? ['week'] : cmd.args;
      const first = args[0]?.toLowerCase();
      const isSpan = first !== undefined && (WINDOWS.includes(first) || /^\d{1,3}d$/.test(first));
      const span = windowFor(isSpan ? first : undefined, now)!;
      const words = (isSpan ? args.slice(1) : args).join(' ').trim().toLowerCase();
      const found = upcoming().filter((e) => {
        const t = Date.parse(e.startTime);
        if (t < span.from || t >= span.to) return false;
        return !words || e.category.toLowerCase().includes(words) || e.title.toLowerCase().includes(words);
      });
      const about = `${span.label}${words ? `, matching “${words}”` : ''}`;
      return list(ctx.roomId, `Events ${about}`, found, deps, `Nothing ${about}.`);
    }

    case 'new': {
      const week = now.getTime() - 7 * 86400_000;
      const found = upcoming()
        .filter((e) => e.firstSeenAt && Date.parse(e.firstSeenAt) >= week)
        .sort((a, b) => (b.firstSeenAt ?? '').localeCompare(a.firstSeenAt ?? ''));
      return list(ctx.roomId, 'Found in the last week', found, deps, 'Nothing new this week.');
    }

    case 'search': {
      const words = cmd.args.join(' ').trim().toLowerCase();
      if (!words) return matrixText(`Search for what? e.g. ${p}search car show`);
      const found = upcoming().filter((e) => `${e.title}\n${e.venueName}\n${e.description}`.toLowerCase().includes(words));
      return list(ctx.roomId, `Upcoming, mentioning “${words}”`, found, deps, `Nothing upcoming mentions “${words}”.`);
    }

    case 'event': {
      const ev = picked(ctx.roomId, cmd.args[0], deps);
      if (typeof ev === 'string') return matrixText(ev);
      const line = matrixLine({ ev }, deps.appUrl);
      const blurb = ev.description ? ev.description.slice(0, 600) : '';
      const extra = [ev.category, ev.priceText, ev.photoScore > 0 ? `📷 ${Math.round(ev.photoScore)}` : ''].filter(Boolean).join(' · ');
      return {
        msgtype: 'm.notice',
        body: [line.text, extra, blurb].filter(Boolean).join('\n'),
        format: 'org.matrix.custom.html',
        formatted_body: `<p>${line.html}</p>${extra ? `<p>${escapeHtml(extra)}</p>` : ''}${blurb ? `<blockquote>${escapeHtml(blurb)}</blockquote>` : ''}`,
      };
    }

    case 'star':
    case 'unstar':
    case 'hide': {
      if (!deps.allowed(ctx.sender)) return matrixText('Only people on the bot’s allowed list can change events.');
      const ev = picked(ctx.roomId, cmd.args[0], deps);
      if (typeof ev === 'string') return matrixText(ev);
      if (cmd.name === 'hide') deps.setFlag(ev.group, 'hidden', true);
      else deps.setFlag(ev.group, 'starred', cmd.name === 'star');
      const verb = cmd.name === 'star' ? '★ Shortlisted' : cmd.name === 'unstar' ? 'Taken off the shortlist' : 'Removed';
      return matrixText(`${verb}: ${ev.title} (${whenText(ev.startTime, ev.dateOnly)}, ${whereText(ev)})${linkFor(ev, deps.appUrl) ? ` ${linkFor(ev, deps.appUrl)}` : ''}`);
    }

    case 'status':
      return matrixText(deps.status());

    default:
      return matrixText(`I don’t know “${p}${cmd.name}”. Try ${p}help`);
  }
}
