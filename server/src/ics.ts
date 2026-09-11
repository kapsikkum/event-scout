interface IcsEvent {
  uid: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string | null;
  venueName: string;
  address: string;
  url: string;
  category?: string;
  lat?: number | null;
  lng?: number | null;
  /** A day with no clock time, written as an all-day event. */
  dateOnly?: boolean;
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The local day as a VALUE=DATE, which has no zone and no time. */
function icsDay(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
}

/**
 * Where an all-day event stops, which RFC 5545 makes exclusive: a one-day
 * event on the 8th ends on the 9th. An end part-way through a day is rounded
 * up to the next midnight, since a date cannot say "until 4pm".
 */
function allDayEnd(ev: IcsEvent): string {
  const start = new Date(ev.startTime);
  const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  let end = ev.endTime ? new Date(ev.endTime) : next;
  if (end.getHours() || end.getMinutes()) {
    end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  }
  return (end > next ? end : next).toISOString();
}

/**
 * Wrap a property onto continuation lines.
 *
 * RFC 5545 caps a line at 75 octets and continues with a leading space. A 500
 * character DESCRIPTION broke that badly; most clients cope, but strict ones
 * reject the whole calendar, which is a miserable thing to debug from the
 * subscriber's end. Counting is done in octets rather than characters because
 * the limit is on bytes and event titles are full of em dashes and emoji.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  // The first line takes 75 octets, continuations 74 plus their leading space.
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte character: continuation bytes are 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return parts.join('\r\n ');
}

export interface IcsOptions {
  /** Shown as the calendar's name once subscribed. */
  name?: string;
  description?: string;
}

export function buildIcs(events: IcsEvent[], opts: IcsOptions = {}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//event-scout//EN',
    'CALSCALE:GREGORIAN',
    // No METHOD. It marks a calendar as an iTIP object -- an invitation or a
    // reply in transit -- and Outlook reads a subscription feed carrying one
    // as exactly that rather than as a calendar to subscribe to. A published
    // feed is not a scheduling message and should not claim to be one.
    `X-WR-CALNAME:${icsEscape(opts.name ?? 'Event Scout')}`,
    // The standard spelling of the same thing (RFC 7986). X-WR-CALNAME is the
    // older convention that every client still reads, so both go out.
    `NAME:${icsEscape(opts.name ?? 'Event Scout')}`,
    // Tells subscribing clients how often to re-poll; without it some check
    // once a day and the feed looks stale.
    'REFRESH-INTERVAL;VALUE=DURATION:PT2H',
    'X-PUBLISHED-TTL:PT2H',
  ];
  if (opts.description) {
    lines.push(`X-WR-CALDESC:${icsEscape(opts.description)}`);
    lines.push(`DESCRIPTION:${icsEscape(opts.description)}`);
  }

  for (const ev of events) {
    const end = ev.endTime ?? new Date(Date.parse(ev.startTime) + 2 * 3600 * 1000).toISOString();
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}@event-scout`,
      `DTSTAMP:${icsDate(new Date().toISOString())}`,
      // A day with no stated time goes in as all-day, so a subscriber's
      // calendar shows it across the top of the day rather than as a
      // midnight appointment.
      ...(ev.dateOnly
        ? [`DTSTART;VALUE=DATE:${icsDay(ev.startTime)}`, `DTEND;VALUE=DATE:${icsDay(allDayEnd(ev))}`]
        : [`DTSTART:${icsDate(ev.startTime)}`, `DTEND:${icsDate(end)}`]),
      `SUMMARY:${icsEscape(ev.title)}`,
      `DESCRIPTION:${icsEscape([ev.description.slice(0, 500), ev.url].filter(Boolean).join('\n'))}`,
      `LOCATION:${icsEscape([ev.venueName, ev.address].filter(Boolean).join(', '))}`,
      ...(ev.category ? [`CATEGORIES:${icsEscape(ev.category)}`] : []),
      ...(ev.lat != null && ev.lng != null ? [`GEO:${ev.lat};${ev.lng}`] : []),
      ...(ev.url ? [`URL:${ev.url}`] : []),
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  // Trailing CRLF included: RFC 5545 3.1 ends *every* content line with one,
  // the last as much as the rest. Most clients shrug at its absence; Outlook
  // refuses the whole calendar and says only that it cannot add it right now.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
