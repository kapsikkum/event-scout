import { useMemo, useState } from 'react';
import { MergedEvent, haversineKm } from '../api';
import { useStore } from '../store';
import EventDetail from '../components/EventDetail';
import { decodeEntities } from '../text';

/**
 * The diary view.
 *
 * Three ways of looking at the same events, because they answer different
 * questions: month is "is this weekend busy", week is "what does Saturday
 * actually look like hour by hour", and agenda is "what is coming up" — which is
 * the one you want most of the time and the one a month grid is worst at.
 */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VIEWS = [
  { key: 'agenda', label: '☰ Agenda' },
  { key: 'month', label: '▦ Month' },
  { key: 'week', label: '▤ Week' },
] as const;
type View = (typeof VIEWS)[number]['key'];

const PALETTE = ['#f5a623', '#4cc3ff', '#4ade80', '#f87171', '#c084fc', '#fb923c', '#2dd4bf', '#e879f9'];

/** Stable colour per category, so a category looks the same in every view. */
function categoryColour(category: string): string {
  let hash = 0;
  for (const ch of category) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const timeOf = (ev: MergedEvent): string =>
  new Date(ev.startTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const startOfWeek = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());

export default function Calendar() {
  const { events, settings } = useStore();
  const [view, setView] = useState<View>('agenda');
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<MergedEvent | null>(null);
  const [category, setCategory] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [copied, setCopied] = useState(false);

  const shown = useMemo(
    () =>
      events.filter(
        (ev) => !ev.hidden && (!category || ev.category === category) && (!starredOnly || ev.starred)
      ),
    [events, category, starredOnly]
  );

  const categories = useMemo(
    () => [...new Set(events.filter((e) => !e.hidden).map((e) => e.category).filter(Boolean))].sort(),
    [events]
  );

  const byDay = useMemo(() => {
    const map = new Map<string, MergedEvent[]>();
    for (const ev of shown) {
      const key = dayKey(new Date(ev.startTime));
      const list = map.get(key);
      if (list) list.push(ev);
      else map.set(key, [ev]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    }
    return map;
  }, [shown]);

  const distanceOf = (ev: MergedEvent): number | null =>
    settings?.lat != null && settings.lng != null && ev.lat != null && ev.lng != null
      ? haversineKm(settings.lat, settings.lng, ev.lat, ev.lng)
      : null;

  const todayKey = dayKey(new Date());

  // --- the feed subscribers get -------------------------------------------
  const feedQuery = [
    starredOnly ? 'starred=1' : '',
    category ? `category=${encodeURIComponent(category)}` : '',
  ].filter(Boolean).join('&');
  const feedPath = `/api/calendar.ics${feedQuery ? `?${feedQuery}` : ''}`;
  const feedUrl = `${window.location.origin}${feedPath}`;

  const copyFeed = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the link is still visible to copy by hand.
    }
  };

  // --- shared row ----------------------------------------------------------
  const EventRow = ({ ev, showDate = false }: { ev: MergedEvent; showDate?: boolean }) => {
    const distance = distanceOf(ev);
    return (
      <button className="calrow" onClick={() => setOpen(ev)}>
        <span className="calrow__time">
          {showDate && (
            <span className="calrow__date">
              {new Date(ev.startTime).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </span>
          )}
          {timeOf(ev)}
        </span>
        <span className="calrow__bar" style={{ background: categoryColour(ev.category || 'Event') }} />
        <span className="calrow__body">
          <span className="calrow__title">{decodeEntities(ev.title)}</span>
          <span className="calrow__where">
            📍 {decodeEntities(ev.venueName || ev.address) || 'Location unknown'}
            {distance != null && ` · ${distance < 10 ? distance.toFixed(1) : Math.round(distance)} km`}
          </span>
        </span>
        <span className="calrow__tags">
          {ev.starred && <span className="calrow__star">★</span>}
          {ev.photoScore >= 40 && <span className="calrow__score">📷 {Math.round(ev.photoScore)}</span>}
          {ev.category && <span className="badge badge--cat">{ev.category}</span>}
        </span>
      </button>
    );
  };

  // --- views ---------------------------------------------------------------
  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    return Array.from(
      { length: 42 },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    );
  }, [cursor]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(cursor);
    return Array.from(
      { length: 7 },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    );
  }, [cursor]);

  const agendaDays = useMemo(() => {
    const now = Date.now() - 3600_000;
    const keys = [...byDay.keys()]
      .filter((k) => byDay.get(k)!.some((ev) => Date.parse(ev.startTime) >= now))
      .sort();
    return keys.map((key) => ({
      key,
      date: new Date(`${key}T12:00:00`),
      events: byDay.get(key)!.filter((ev) => Date.parse(ev.startTime) >= now),
    }));
  }, [byDay]);

  const step = (delta: number): void => {
    if (view === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1));
    else setCursor(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + delta * 7));
  };

  const heading =
    view === 'month'
      ? cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${weekDays[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${weekDays[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
        : `${agendaDays.reduce((n, d) => n + d.events.length, 0)} upcoming`;

  const selectedEvents = selected ? byDay.get(selected) ?? [] : [];

  return (
    <>
      <div className="calbar">
        <div className="chiprow">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={`chip ${view === v.key ? 'active' : ''}`}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>

        {view !== 'agenda' && (
          <div className="calnav">
            <button onClick={() => step(-1)} aria-label="Previous">←</button>
            <button onClick={() => setCursor(new Date())}>Today</button>
            <button onClick={() => step(1)} aria-label="Next">→</button>
          </div>
        )}

        <h2 className="calbar__title">{heading}</h2>

        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={starredOnly} onChange={(e) => setStarredOnly(e.target.checked)} />
          ★ Shortlist only
        </label>
      </div>

      <div className="calfeed">
        <span className="calfeed__label">📅 Subscribe</span>
        <code className="calfeed__url" title={feedUrl}>{feedUrl}</code>
        <button onClick={() => void copyFeed()}>{copied ? '✓ Copied' : 'Copy link'}</button>
        <a href={feedUrl.replace(/^https?:/, 'webcal:')}>Open in calendar app</a>
        <a href={`/api/export.ics${feedQuery ? `?${feedQuery}` : ''}`} download>Download .ics</a>
        <span className="calfeed__note">
          Live feed — it follows the filters above and refreshes every couple of hours.
        </span>
      </div>

      {view === 'agenda' && (
        <div className="agenda">
          {agendaDays.length === 0 && <div className="empty"><p>Nothing coming up with these filters.</p></div>}
          {agendaDays.map(({ key, date, events: dayEvents }) => (
            <section key={key} className={`agenda__day${key === todayKey ? ' is-today' : ''}`}>
              <h3>
                {date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
                {key === todayKey && <span className="agenda__today">Today</span>}
                <span className="agenda__count">{dayEvents.length}</span>
              </h3>
              {dayEvents.map((ev) => <EventRow key={ev.group} ev={ev} />)}
            </section>
          ))}
        </div>
      )}

      {view === 'month' && (
        <>
          <div className="calgrid">
            {DOW.map((d) => <div key={d} className="dow">{d}</div>)}
            {monthCells.map((d) => {
              const key = dayKey(d);
              const dayEvents = byDay.get(key) ?? [];
              const classes = [
                'calcell',
                d.getMonth() !== cursor.getMonth() ? 'outside' : '',
                key === todayKey ? 'today' : '',
                key === selected ? 'selected' : '',
              ].filter(Boolean).join(' ');
              return (
                <div key={key} className={classes} onClick={() => setSelected(key === selected ? null : key)}>
                  <div className="num">{d.getDate()}</div>
                  {dayEvents.slice(0, 3).map((ev) => (
                    <div key={ev.group} className="evchip" title={`${timeOf(ev)} · ${decodeEntities(ev.title)}`}>
                      <span className="evchip__dot" style={{ background: categoryColour(ev.category || 'Event') }} />
                      <span className="evchip__time">{timeOf(ev)}</span>
                      {decodeEntities(ev.title)}
                    </div>
                  ))}
                  {dayEvents.length > 3 && <div className="more">+{dayEvents.length - 3} more</div>}
                </div>
              );
            })}
          </div>
          {selected && (
            <div className="dayevents">
              <h3>
                {new Date(`${selected}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: 'long', month: 'long', day: 'numeric',
                })}
                {' — '}{selectedEvents.length} event{selectedEvents.length === 1 ? '' : 's'}
              </h3>
              {selectedEvents.map((ev) => <EventRow key={ev.group} ev={ev} />)}
            </div>
          )}
        </>
      )}

      {view === 'week' && (
        <div className="calweek">
          {weekDays.map((d) => {
            const key = dayKey(d);
            const dayEvents = byDay.get(key) ?? [];
            return (
              <section key={key} className={`calweek__day${key === todayKey ? ' is-today' : ''}`}>
                <h4>
                  <span>{DOW[d.getDay()]}</span>
                  <span className="calweek__num">{d.getDate()}</span>
                </h4>
                {dayEvents.length === 0 ? (
                  <p className="calweek__empty">—</p>
                ) : (
                  dayEvents.map((ev) => (
                    <button key={ev.group} className="calweek__ev" onClick={() => setOpen(ev)}>
                      <span className="calweek__time">{timeOf(ev)}</span>
                      <span
                        className="calweek__bar"
                        style={{ background: categoryColour(ev.category || 'Event') }}
                      />
                      <span className="calweek__title">{decodeEntities(ev.title)}</span>
                      <span className="calweek__venue">{decodeEntities(ev.venueName || ev.address)}</span>
                    </button>
                  ))
                )}
              </section>
            );
          })}
        </div>
      )}

      {open && (
        <EventDetail
          ev={events.find((e) => e.group === open.group) ?? open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
