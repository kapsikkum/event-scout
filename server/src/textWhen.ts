import type { EventWhen } from './when.js';

/**
 * A date out of prose: a caption, a page's blurb, a flyer's text.
 *
 * For a page that carries no event data a program can read — no schema.org
 * block, no Facebook event — which is most small clubs' and pubs' own sites
 * and every Instagram post. What such a page does have is a sentence saying
 * "Sunday 13th Sept, 5am meetup", and this finds that.
 *
 * The crawler has the same reader in crawler/src/extract/social.ts, which is
 * where it was worked out against real captions. They are separate programs
 * with no shared code, so a fix to one belongs in both — the same arrangement
 * as when.ts.
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const monthIndex = (name: string): number | undefined => MONTHS[name.slice(0, 3).toLowerCase()];

const MON = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
/** "13th Sept", "24th of September 2026". */
const DAY_MONTH = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?[\s,]+(${MON})\b\.?(?:,?\s+(20\d\d))?`, 'gi');
/** "September 24", "Sept 13th, 2026" — but not the 7 in "September 7:30pm", which is a time. */
const MONTH_DAY = new RegExp(String.raw`\b(${MON})\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?![:.]\d|\s*[ap]\.?m\b)(?:,?\s+(20\d\d))?`, 'gi');
/** "12/10/2026", day first. Only with a year: "1/2" is as often a fraction. */
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
 * When a piece of text says the event is.
 *
 * The first date in it on or after `from` — the day it was posted, or today.
 * A year left out is the one that puts the date on or after that day, and a
 * date more than nine months on is taken for a mention of something past. The
 * time is the first one after the date, or failing that on a line that says
 * "Time"; with neither it is a date and nothing more.
 */
export function whenFromText(text: string, from: Date | null, now = new Date()): EventWhen | null {
  const posted = from ?? now;
  const postedDay = new Date(posted.getFullYear(), posted.getMonth(), posted.getDate());
  const nineMonths = 270 * 86400000;

  for (const c of candidates(text)) {
    let at = realDay(c.year ?? postedDay.getFullYear(), c.month, c.day);
    if (!at) continue;
    if (c.year === null && at < postedDay) at = realDay(postedDay.getFullYear() + 1, c.month, c.day);
    if (!at || at < postedDay) continue;
    if (c.year === null && at.getTime() - postedDay.getTime() > nineMonths) continue;

    const time = clock(text.slice(c.end, c.end + 150)) ?? clock(/\btimes?\b[^\n]{0,40}/i.exec(text)?.[0] ?? '');
    if (!time) return { startTime: at.toISOString(), dateOnly: true };
    const start = new Date(at.getFullYear(), at.getMonth(), at.getDate(), time.hour, time.minute);
    return { startTime: start.toISOString(), dateOnly: false };
  }
  return relativeWhen(text, postedDay);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const RELATIVE = /\b(tonight|tomorrow|(?:this|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend))\b/i;

/** "This Sunday", "tomorrow", "this weekend", relative to the day of posting. */
function relativeWhen(text: string, postedDay: Date): EventWhen | null {
  const m = RELATIVE.exec(text);
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
  const time = clock(text.slice(end, end + 150)) ?? clock(/\btimes?\b[^\n]{0,40}/i.exec(text)?.[0] ?? '');
  if (!time) return { startTime: at.toISOString(), dateOnly: true };
  return {
    startTime: new Date(at.getFullYear(), at.getMonth(), at.getDate(), time.hour, time.minute).toISOString(),
    dateOnly: false,
  };
}

/** "Penrith NSW" is searched for as "Penrith". */
function areaWord(area: string): string {
  return area.split(',')[0].trim().replace(/\s+[A-Z]{2,3}$/, '').trim();
}

/**
 * Which of the areas a piece of text names, capitalised or shouted, first
 * mention winning. "an orange car" is not Orange. See the crawler's copy.
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
