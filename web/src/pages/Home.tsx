import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DensityArea, MergedEvent, VenueReading } from '../api';
import { useStore } from '../store';
import { formatWhen } from '../components/EventCard';
import { busyColour } from '../busy';
import { decodeEntities } from '../text';
import PhotoConditionsPanel from '../components/PhotoConditions';
import EventDetail from '../components/EventDetail';

/**
 * Landing page: what you've shortlisted, and where people actually are right
 * now. Both answer the same scouting question from opposite ends — the diary
 * and the live picture.
 */

interface AreaVenues {
  area: DensityArea;
  venues: VenueReading[];
}

export default function Home() {
  const { events, settings, status } = useStore();
  const [areas, setAreas] = useState<AreaVenues[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<MergedEvent | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { areas: list } = await api.densityAreas();
        const withVenues = await Promise.all(
          list.map(async (area) => ({ area, venues: await api.venues(area.slug).catch(() => []) }))
        );
        if (alive) setAreas(withVenues);
      } catch {
        if (alive) setAreas([]);
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void load();
    // Busyness moves through the day; a slow poll keeps the page honest.
    const id = setInterval(load, 120_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const now = Date.now();
  const shortlist = events
    .filter((ev) => ev.starred && !ev.hidden && Date.parse(ev.startTime) >= now - 3600_000)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

  // Only live readings belong in "right now"; typical-for-this-hour is a guess.
  const live = areas
    .flatMap(({ area, venues }) => venues.map((v) => ({ ...v, areaName: area.name })))
    .filter((v) => v.live != null)
    .sort((a, b) => (b.live ?? 0) - (a.live ?? 0));

  const multiArea = areas.length > 1;
  const sampledAt = live.find((v) => v.observedAt)?.observedAt ?? null;

  return (
    <div className="home-wrap">
      <div className="home">
        <section className="home__panel">
        <div className="home__head">
          <h2>⭐ Your shortlist</h2>
          <Link to="/events" className="home__more">All events →</Link>
        </div>

        {shortlist.length === 0 ? (
          <p className="hint">
            Nothing shortlisted yet. Star an event on the{' '}
            <Link to="/events">Events</Link> page and it will show up here.
          </p>
        ) : (
          <ul className="home__list">
            {shortlist.slice(0, 8).map((ev) => (
              <li key={ev.group} className="home__event">
                <div className="home__event-when">{formatWhen(ev)}</div>
                <div className="home__event-body">
                  {/* Opens the in-app view rather than the source site: the
                      links, map and organiser all live there. */}
                  <button className="linklike home__event-title" onClick={() => setOpen(ev)}>
                    {decodeEntities(ev.title)}
                  </button>
                  {(ev.venueName || ev.address) && (
                    <div className="home__event-venue">{decodeEntities(ev.venueName || ev.address)}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {shortlist.length > 8 && (
          <p className="hint">+ {shortlist.length - 8} more shortlisted</p>
        )}
        </section>

        <section className="home__panel">
          <div className="home__head">
            <h2>🔥 Busiest right now</h2>
          <Link to="/map" className="home__more">Map →</Link>
        </div>

        {!loaded ? (
          <p className="hint">Loading…</p>
        ) : live.length === 0 ? (
          <p className="hint">
            No live readings yet. Enable <b>Venue density</b> under{' '}
            <Link to="/settings">Settings</Link>, then use <b>Sample now</b>.
          </p>
        ) : (
          <>
            <ul className="home__list">
              {live.slice(0, 10).map((v) => (
                <li key={`${v.areaName}-${v.name}@${v.lat},${v.lon}`} className="home__venue">
                  <span className="dot" style={{ background: busyColour((v.live ?? 0) / 100) }} />
                  <span className="home__venue-name">
                    {v.name}
                    {multiArea && <span className="home__venue-area"> · {v.areaName}</span>}
                  </span>
                  <span className="home__venue-pct">{v.live}%</span>
                  {v.typical != null && (
                    <span className="home__venue-typical">
                      {v.live! > v.typical ? '↑' : v.live! < v.typical ? '↓' : '·'} usually {v.typical}%
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {sampledAt && (
              <p className="hint">Sampled {new Date(sampledAt).toLocaleTimeString()}</p>
            )}
          </>
        )}
      </section>

        <section className="home__panel home__panel--wide">
          <div className="home__head">
            <h2>📅 Coming up</h2>
            <Link to="/calendar" className="home__more">Calendar →</Link>
          </div>
          <p className="hint">
            {settings?.city ? `Tracking ${settings.city}` : 'No location set'}
            {status?.lastRefresh && ` · events updated ${new Date(status.lastRefresh).toLocaleString()}`}
            {areas.length > 0 &&
              ` · ${areas.reduce((n, a) => n + a.venues.length, 0)} venues watched`}
          </p>
        </section>
      </div>

      <PhotoConditionsPanel />

      {open && (
        <EventDetail
          // Re-read from the store so star/remove stays live while it is open.
          ev={events.find((e) => e.group === open.group) ?? open}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
