import { useState } from 'react';
import { MergedEvent, haversineKm } from '../api';
import { decodeEntities } from '../text';
import { useStore } from '../store';
import EventImage from './EventImage';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function formatWhen(ev: MergedEvent): string {
  const start = new Date(ev.startTime);
  const day = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

interface EventCardProps {
  ev: MergedEvent;
  onOpen?: (ev: MergedEvent) => void;
  /** Present only while the Events page is in merge mode. */
  selected?: boolean;
  onSelect?: (group: string, selected: boolean) => void;
}

export default function EventCard({ ev, onOpen, selected, onSelect }: EventCardProps) {
  const { settings, setGroupFlag } = useStore();
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
          {[...new Set(ev.sources.map((s) => s.source))].map((source) => (
            <span key={source} className={`badge src-${source}`}>
              {source === 'facebook' ? 'facebook*' : source === 'websearch' ? 'web*' : source}
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
            title={ev.hidden ? 'Restore this event' : 'Remove this event from all views'}
            onClick={() => void setGroupFlag(ev.group, { hidden: !ev.hidden })}
          >
            {ev.hidden ? 'Restore' : 'Remove'}
          </button>
        </div>
      </div>
    </article>
  );
}
