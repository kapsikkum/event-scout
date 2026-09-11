import { useState } from 'react';
import { MergedEvent, haversineKm } from '../api';
import { decodeEntities } from '../text';
import { useStore } from '../store';
import EventImage from './EventImage';
import { enrichedTooltip, isEnriched } from '../enriched';
import { isRecent } from '../filtering';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The asterisked ones are scraped rather than read from an official feed. */
const SOURCE_LABELS: Record<string, string> = {
  facebook: 'facebook*',
  websearch: 'web*',
  crawler: '🕷 crawler',
};

/**
 * Which sites the crawler read this off. The badge alone says "crawler", which
 * is where it came from but not whose page it was, and that is the part worth
 * knowing before trusting it.
 */
function sourceTitle(ev: MergedEvent, source: string): string | undefined {
  if (source !== 'crawler') return undefined;
  const hosts = new Set<string>();
  for (const s of ev.sources) {
    if (s.source !== 'crawler' || !s.url) continue;
    try {
      hosts.add(new URL(s.url).hostname.replace(/^www\./, ''));
    } catch {
      // A listing with a broken link still came from the crawler.
    }
  }
  return hosts.size ? `Found by the crawler on ${[...hosts].join(', ')}` : 'Found by the crawler';
}

/**
 * When an event is on, as it appears on a card, the map and the detail panel.
 *
 * The year is shown only when it is not the current one. Most of what is listed
 * is within the next few months, where "Sat, Sep 12" is how a person would say
 * it and a year is noise on every card — but the sources do carry dates a year
 * or more out, and those read as though they were this year's.
 */
export function formatWhen(ev: MergedEvent): string {
  const start = new Date(ev.startTime);
  const otherYear = start.getFullYear() !== new Date().getFullYear();
  const day = start.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(otherYear ? { year: 'numeric' } : {}),
  });
  // A day with no stated time is shown as the day. It is stored as local
  // midnight, and printing that would be inventing "12:00 am".
  if (ev.dateOnly) return day;
  const time = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** "Also on Tue 15 Sept, Fri 18 Sept … and 12 more", for the series badge. */
function seriesTitle(dates: MergedEvent[]): string {
  const shown = 10;
  const days = dates
    .slice(1, shown + 1)
    .map((d) => new Date(d.startTime).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
  const more = dates.length - 1 - days.length;
  return `Also on ${days.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

interface EventCardProps {
  ev: MergedEvent;
  /** Every date of this event's series on the page, `ev` first. See foldSeries. */
  dates?: MergedEvent[];
  onOpen?: (ev: MergedEvent) => void;
  /** Present only while the Events page is in merge mode. */
  selected?: boolean;
  onSelect?: (group: string, selected: boolean) => void;
}

export default function EventCard({ ev, dates, onOpen, selected, onSelect }: EventCardProps) {
  const { settings, setGroupFlag, events } = useStore();
  // Removing a folded card removes the series, every date of it and not only
  // the ones the filters let through: nobody wants to remove it twenty-seven
  // times. Shortlisting stays with the one date, which is the one you'd go to.
  const series = dates && dates.length > 1 ? events.filter((e) => e.series === ev.series) : [ev];
  const setHidden = (hidden: boolean): void => {
    for (const e of series) void setGroupFlag(e.group, { hidden });
  };
  const [noImage, setNoImage] = useState(false);
  const start = new Date(ev.startTime);
  const distance =
    settings?.lat != null && settings.lng != null && ev.lat != null && ev.lng != null
      ? haversineKm(settings.lat, settings.lng, ev.lat, ev.lng)
      : null;
  const mainUrl = ev.sources.find((s) => s.url)?.url;
  // The venue is the useful half; the street address is supporting detail, and
  // repeating the venue inside it just makes the line long.
  const place = decodeEntities(ev.venueName || ev.address || '').trim();
  const rawAddress = decodeEntities(ev.address || '').trim();
  const suburb = ev.venueName && rawAddress && rawAddress !== place ? rawAddress : '';

  return (
    <article className={`card${selected ? ' is-selected' : ''}`}>
      <div className="thumb">
        {onSelect && (
          <label className="card__pick" title="Select for merging">
            <input
              type="checkbox"
              checked={Boolean(selected)}
              onChange={(e) => onSelect(ev.group, e.target.checked)}
            />
          </label>
        )}
        {ev.images.length > 0 && !noImage ? (
          <EventImage images={ev.images} onNone={() => setNoImage(true)} />
        ) : (
          <span>📷</span>
        )}
        <div className="datebadge">
          <div className="mon">{MONTHS[start.getMonth()]}</div>
          <div className="day">{start.getDate()}</div>
        </div>
        {ev.photoScore >= 40 && <div className="score">📷 {Math.round(ev.photoScore)}</div>}
      </div>
      <div className="body">
        <h3>
          {onOpen ? (
            <button className="linklike" onClick={() => onOpen(ev)}>{decodeEntities(ev.title)}</button>
          ) : mainUrl ? (
            <a href={mainUrl} target="_blank" rel="noreferrer">{decodeEntities(ev.title)}</a>
          ) : (
            decodeEntities(ev.title)
          )}
        </h3>
        <div className="when">{formatWhen(ev)}</div>

        {/* Where it is, on its own line and not in muted small print: on a
            scouting list this matters as much as the time. */}
        <div className={`card__where${place ? '' : ' is-unknown'}`}>
          <span className="card__pin">{ev.isOnline ? '💻' : '📍'}</span>
          <span className="card__place">
            {place || (ev.isOnline ? 'Online event' : 'Location unknown')}
          </span>
          {distance != null && (
            <span className="card__dist">
              {distance < 10 ? distance.toFixed(1) : Math.round(distance)} km
            </span>
          )}
        </div>
        {suburb && <div className="card__addr">{suburb}</div>}
        {ev.priceText && <div className="venue">{ev.priceText}</div>}
        <div className="badges">
          {ev.category && <span className="badge badge--cat">{ev.category}</span>}
          {ev.members.length > 1 && (
            <span className="badge badge--merged" title={ev.manual ? 'Merged by hand' : 'Matched automatically'}>
              {ev.manual ? '⛓ ' : '⧉ '}{ev.members.length} listings
            </span>
          )}
          {/* Which parts of this card a model wrote. The detail view spells it
              out; here there is only room to say that some of it was. */}
          {isEnriched(ev) && (
            <span className="badge badge--ai" title={enrichedTooltip(ev)}>✨ AI</span>
          )}
          {dates && dates.length > 1 && (
            <span className="badge badge--series" title={seriesTitle(dates)}>
              ↻ {dates.length} dates
            </span>
          )}
          {isRecent(ev) && ev.firstSeenAt && (
            <span
              className="badge badge--new"
              title={`First found ${new Date(ev.firstSeenAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`}
            >
              ✦ New
            </span>
          )}
          {[...new Set(ev.sources.map((s) => s.source))].map((source) => (
            <span key={source} className={`badge src-${source}`} title={sourceTitle(ev, source)}>
              {SOURCE_LABELS[source] ?? source}
            </span>
          ))}
        </div>
        <div className="actions">
          {onOpen && (
            <button title="View details in the app" onClick={() => onOpen(ev)}>
              Details
            </button>
          )}
          <button
            className={ev.starred ? 'starred' : ''}
            title={ev.starred ? 'Remove from shortlist' : 'Add to shortlist'}
            onClick={() => void setGroupFlag(ev.group, { starred: !ev.starred })}
          >
            {ev.starred ? '★ Shortlisted' : '☆ Shortlist'}
          </button>
          <button
            title={
              series.length > 1
                ? `${ev.hidden ? 'Restore' : 'Remove'} all ${series.length} dates of this event`
                : ev.hidden ? 'Restore this event' : 'Remove this event from all views'
            }
            onClick={() => setHidden(!ev.hidden)}
          >
            {ev.hidden ? 'Restore' : 'Remove'}
          </button>
        </div>
      </div>
    </article>
  );
}
