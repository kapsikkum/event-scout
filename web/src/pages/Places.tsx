import { useEffect, useState } from 'react';
import { api, DensityArea, VenueHistory, VenueReading } from '../api';
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

export default function Places() {
  const [areas, setAreas] = useState<DensityArea[]>([]);
  const [area, setArea] = useState('');
  const [venues, setVenues] = useState<VenueReading[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, VenueHistory>>({});
  const [day, setDay] = useState(new Date().getDay());
  const [filter, setFilter] = useState('');

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
      const rank = (v: VenueReading) => (v.live != null ? 0 : v.typical != null ? 1 : 2);
      return rank(a) - rank(b) || (b.live ?? b.typical ?? 0) - (a.live ?? a.typical ?? 0);
    });

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
          return (
            <li key={`${v.name}@${v.lat},${v.lon}`} className={expanded ? 'is-open' : ''}>
              <button className="places__row" onClick={() => void toggle(v.name)}>
                <span className="dot" style={{ background: busyColour(v.score) }} />
                <span className="places__name">{v.name}</span>
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
                      <div className="places__days">
                        {DAYS.map((d, i) => (
                          <button
                            key={d}
                            className={i === day ? 'active' : ''}
                            disabled={!h.byDay?.[d] || Object.keys(h.byDay[d]).length === 0}
                            onClick={() => setDay(i)}
                          >
                            {d.slice(0, 3)}
                          </button>
                        ))}
                      </div>

                      {profileDay && Object.keys(profileDay).length > 0 ? (
                        <>
                          <BusyChart
                            hours={profileDay}
                            observed={day === new Date().getDay() ? h.observedByHour : undefined}
                            markHour={day === new Date().getDay() ? hourNow : null}
                          />
                          <p className="places__legend">
                            Bars: typical for {DAYS[day]} · dots: measured ·{' '}
                            {h.points.length} reading{h.points.length === 1 ? '' : 's'} in 14 days
                          </p>
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
                                  weekday: 'short', hour: '2-digit', minute: '2-digit',
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
