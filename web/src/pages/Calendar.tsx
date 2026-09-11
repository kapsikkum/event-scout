import { useEffect, useMemo, useState } from 'react';
import { MergedEvent, api, haversineKm } from '../api';
import { useStore } from '../store';
import EventDetail from '../components/EventDetail';
import { decodeEntities } from '../text';
import { outOfSight } from '../filtering';

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
  ev.dateOnly ? 'All day' : new Date(ev.startTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const startOfWeek = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());

const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * Over and done, by the rule the server uses: the end if there is one,
 * otherwise the whole of the day it starts on.
 */
function isPast(ev: MergedEvent, now = Date.now()): boolean {
  const end = ev.endTime ? Date.parse(ev.endTime) : NaN;
  if (Number.isFinite(end)) return end < now;
  const start = new Date(ev.startTime);
  return addDays(new Date(start.getFullYear(), start.getMonth(), start.getDate()), 1).getTime() <= now;
}

export default function Calendar() {
  const { events, settings } = useStore();
  const [view, setView] = useState<View>('agenda');
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<MergedEvent | null>(null);
  const [category, setCategory] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  // Past events, fetched a page at a time as the grid is paged back through.
  // The store holds only what is still to come, which is what every other
  // page wants; a month grid is the one place last week is worth seeing.
  const [past, setPast] = useState<MergedEvent[]>([]);

  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [cursor]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(cursor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [cursor]);

  // The days on screen, as [first, day after last]. None for the agenda,
  // which only looks forward.
  const range = view === 'month' ? [monthCells[0], addDays(monthCells[41], 1)] : view === 'week' ? [weekDays[0], addDays(weekDays[6], 1)] : null;
  const rangeKey = range ? `${dayKey(range[0])}/${dayKey(range[1])}` : '';

  useEffect(() => {
    if (!range || range[0].getTime() > Date.now()) return;
    let stale = false;
    api
      .pastEvents(range[0], range[1])
      .then((found) => {
        if (stale) return;
        // Added to rather than replaced, so paging back and forth does not
        // blank the days already seen while the next page loads.
        setPast((prev) => {
          const byGroup = new Map(prev.map((ev) => [ev.group, ev]));
          for (const ev of found) byGroup.set(ev.group, ev);
          return [...byGroup.values()];
        });
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // rangeKey stands for range, which is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  const all = useMemo(() => {
    const live = new Set(events.map((ev) => ev.group));
    return [...events, ...past.filter((ev) => !live.has(ev.group))];
  }, [events, past]);

  const shown = useMemo(
    () =>
      all.filter(
        (ev) => !outOfSight(ev) && (!category || ev.category === category) && (!starredOnly || ev.starred)
      ),
    [all, category, starredOnly]
  );

  const categories = useMemo(
    () => [...new Set(all.filter((e) => !outOfSight(e)).map((e) => e.category).filter(Boolean))].sort(),
    [all]
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
      <button className={`calrow${isPast(ev) ? ' is-past' : ''}`} onClick={() => setOpen(ev)}>
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
                {/* The agenda runs forward without a month heading over it, so
                    unlike the month view it has nothing else to say which year
                    a day belongs to. */}
                {date.toLocaleDateString(undefined, {
                  weekday: 'long', day: 'numeric', month: 'long',
                  ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
                })}
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
                key < todayKey ? 'past' : '',
                key === todayKey ? 'today' : '',
                key === selected ? 'selected' : '',
              ].filter(Boolean).join(' ');
              return (
                <div key={key} className={classes} onClick={() => setSelected(key === selected ? null : key)}>
                  <div className="num">{d.getDate()}</div>
                  {/* Each chip opens its event; the rest of the cell picks
                      the day, which lists all of them below the grid. */}
                  {dayEvents.slice(0, 3).map((ev) => (
                    <button
                      key={ev.group}
                      type="button"
                      className={`evchip${isPast(ev) ? ' is-past' : ''}`}
                      title={`${timeOf(ev)} · ${decodeEntities(ev.title)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(ev);
                      }}
                    >
                      <span className="evchip__dot" style={{ background: categoryColour(ev.category || 'Event') }} />
                      <span className="evchip__time">{timeOf(ev)}</span>
                      <span className="evchip__title">{decodeEntities(ev.title)}</span>
                    </button>
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
                    <button
                      key={ev.group}
                      className={`calweek__ev${isPast(ev) ? ' is-past' : ''}`}
                      onClick={() => setOpen(ev)}
                    >
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
          ev={all.find((e) => e.group === open.group) ?? open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
