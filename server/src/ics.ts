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
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
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
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(opts.name ?? 'Event Scout')}`,
    // Tells subscribing clients how often to re-poll; without it some check
    // once a day and the feed looks stale.
    'REFRESH-INTERVAL;VALUE=DURATION:PT2H',
    'X-PUBLISHED-TTL:PT2H',
  ];
  if (opts.description) lines.push(`X-WR-CALDESC:${icsEscape(opts.description)}`);

  for (const ev of events) {
    const end = ev.endTime ?? new Date(Date.parse(ev.startTime) + 2 * 3600 * 1000).toISOString();
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}@event-scout`,
      `DTSTAMP:${icsDate(new Date().toISOString())}`,
      `DTSTART:${icsDate(ev.startTime)}`,
      `DTEND:${icsDate(end)}`,
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
