import { useEffect, useState } from 'react';
import { api, DensityArea, ShootVerdict, VenueHistory, VenueReading } from '../api';
import { busyColour } from '../busy';
import BusyChart from '../components/BusyChart';

/**
 * Every tracked place, with how busy it is now and how busy it usually is.
 *
 * The weekly profile answers "when is this place worth shooting"; the observed
 * readings answer "is today unusual". Both are shown together rather than in
 * separate views, because either alone is misleading.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 9 and 13 -> "9:00-14:00", the window running to the end of the last hour. */
const windowLabel = (from: number, to: number): string => `${from}:00–${to + 1}:00`;

function ShootBadge({ shoot }: { shoot: ShootVerdict }) {
  if (shoot.label === 'Unknown') return null;
  return (
    <span
      className={`shoot shoot--${shoot.label.toLowerCase()}${shoot.estimated ? ' is-estimated' : ''}`}
      title={shoot.why}
    >
      📷 {shoot.estimated ? '~' : ''}{shoot.label}
      {shoot.surge && <span className="shoot__surge"> ↑</span>}
    </span>
  );
}

export default function Places() {
  const [areas, setAreas] = useState<DensityArea[]>([]);
  const [area, setArea] = useState('');
  const [venues, setVenues] = useState<VenueReading[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, VenueHistory>>({});
  const [day, setDay] = useState(new Date().getDay());
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'busy' | 'shoot'>('busy');

  useEffect(() => {
    api.densityAreas()
      .then((r) => {
        setAreas(r.areas);
        if (r.areas.length) setArea(r.areas[0].slug);
      })
      .catch(() => setAreas([]));
  }, []);

  useEffect(() => {
    if (!area) return;
    api.venues(area).then(setVenues).catch(() => setVenues([]));
    setOpen(null);
    setHistory({});
  }, [area]);

  const toggle = async (name: string): Promise<void> => {
    if (open === name) return setOpen(null);
    setOpen(name);
    if (history[name]) return;
    try {
      const h = await api.venueHistory(area, name, 14);
      setHistory((prev) => ({ ...prev, [name]: h }));
    } catch {
      // Leaves the row expanded with a "no history" note.
    }
  };

  const shown = venues
    .filter((v) => v.name.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => {
      if (sort === 'shoot') {
        return (b.shoot?.score ?? 0) - (a.shoot?.score ?? 0) || a.name.localeCompare(b.name);
      }
      const rank = (v: VenueReading) => (v.live != null ? 0 : v.typical != null ? 1 : 2);
      return rank(a) - rank(b) || (b.live ?? b.typical ?? 0) - (a.live ?? a.typical ?? 0);
    });

  const today = new Date().getDay();
  const hourNow = new Date().getHours();

  return (
    <div className="places">
      <div className="places__bar">
        {areas.length > 1 && (
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            {areas.map((a) => (
              <option key={a.slug} value={a.slug}>{a.name}</option>
            ))}
          </select>
        )}
        <input
          value={filter}
          placeholder="Filter places…"
          onChange={(e) => setFilter(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as 'busy' | 'shoot')}>
          <option value="busy">Busiest first</option>
          <option value="shoot">Best to shoot</option>
        </select>
        <span className="places__count">{shown.length} of {venues.length}</span>
      </div>

      {venues.length === 0 && (
        <p className="hint">
          No places tracked yet. Enable <b>Venue density</b> in Settings, then use{' '}
          <b>Rebuild venue list</b>.
        </p>
      )}

      <ul className="places__list">
        {shown.map((v) => {
          const h = history[v.name];
          const expanded = open === v.name;
          const profileDay = h?.byDay?.[DAYS[day]] ?? null;
          const summary = h?.daySummary?.[day];
          return (
            <li key={`${v.name}@${v.lat},${v.lon}`} className={expanded ? 'is-open' : ''}>
              <button className="places__row" onClick={() => void toggle(v.name)}>
                <span className="dot" style={{ background: busyColour(v.score) }} />
                <span className="places__name">{v.name}</span>
                {v.shoot && <ShootBadge shoot={v.shoot} />}
                {v.busiestDay && (
                  <span className="places__busiest">
                    busiest {v.busiestDay}
                    {v.busiestHour != null && ` ${v.busiestHour}:00`}
                  </span>
                )}
                <span className="places__pct">
                  {v.live != null ? `${v.live}%` : v.typical != null ? `~${v.typical}%` : '–'}
                </span>
                <span className="places__chev">{expanded ? '▾' : '▸'}</span>
              </button>

              {expanded && (
                <div className="places__detail">
                  {!h ? (
                    <p className="hint">Loading…</p>
                  ) : (
                    <>
                      {h.now && (
                        <p className="places__verdict">
                          <ShootBadge shoot={h.now} /> <span>{h.now.why}</span>
                        </p>
                      )}

                      <div className="places__days">
                        {DAYS.map((d, i) => (
                          <button
                            key={d}
                            className={i === day ? 'active' : ''}
                            disabled={!h.byDay?.[d] || Object.keys(h.byDay[d]).length === 0}
                            onClick={() => setDay(i)}
                            title={i === today ? 'Today' : undefined}
                          >
                            {d.slice(0, 3)}
                            {i === today && <span className="places__istoday">•</span>}
                          </button>
                        ))}
                      </div>

                      {profileDay && Object.keys(profileDay).length > 0 ? (
                        <>
                          <BusyChart
                            hours={profileDay}
                            // Measured readings for the weekday being shown, not
                            // for today: picking a tab is asking what that day
                            // looks like.
                            observed={h.observedByDay?.[day]}
                            light={h.lightByDay?.[day]}
                            best={summary?.best ?? null}
                            markHour={day === today ? hourNow : null}
                          />
                          <p className="places__legend">
                            Bars: typical for {DAYS[day]} · dots: measured live ·{' '}
                            {summary?.live
                              ? `${summary.live} live reading${summary.live === 1 ? '' : 's'} on ${DAYS[day].slice(0, 3)}`
                              : `no live readings on ${DAYS[day].slice(0, 3)} yet`}
                            {summary && summary.readings > summary.live &&
                              ` (of ${summary.readings} checks)`}
                          </p>
                          {summary?.best ? (
                            <p className="places__best">
                              📷 Best on {DAYS[day]}:{' '}
                              <b>{windowLabel(summary.best.from, summary.best.to)}</b>{' '}
                              <span className="places__sub">
                                — {summary.best.label.toLowerCase()} for photos
                              </span>
                            </p>
                          ) : (
                            <p className="places__best places__sub">
                              📷 Nothing worth a trip on {DAYS[day]} — too quiet all day.
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="hint">Closed on {DAYS[day]}, or no profile.</p>
                      )}

                      {h.points.length > 0 && (
                        <div className="places__recent">
                          <h5>Recent readings</h5>
                          <ul>
                            {h.points.slice(-8).reverse().map((p) => (
                              <li key={p.ts}>
                                <span>{new Date(p.ts * 1000).toLocaleString(undefined, {
                                  weekday: 'short', day: 'numeric', month: 'short',
                                  hour: '2-digit', minute: '2-digit',
                                })}</span>
                                <span className="places__reading">
                                  {p.live != null ? `${p.live}%` : '–'}
                                  {p.typical != null && (
                                    <span className="places__vs">
                                      {p.live != null && p.live > p.typical ? ' ↑' :
                                        p.live != null && p.live < p.typical ? ' ↓' : ' ·'}
                                      {p.typical}%
                                    </span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
