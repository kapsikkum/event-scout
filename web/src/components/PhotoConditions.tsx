import { useEffect, useState } from 'react';
import { api, PhotoConditions as Conditions, SunDay, WeatherDay, MoonInfo } from '../api';

/**
 * Shooting conditions: light windows, sky and moon for today and tomorrow.
 *
 * Golden and blue hour matter more than sunrise itself, so they lead. Cloud
 * cover is called out separately from the weather summary because it is the
 * number that actually decides whether a sunset is worth driving to.
 */

const time = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';

const span = (w: { start: string; end: string } | null): string =>
  w ? `${time(w.start)} – ${time(w.end)}` : '—';

/** Clear skies are flat; broken cloud is what makes a sky worth shooting. */
function cloudNote(pct: number | null): string {
  if (pct == null) return '';
  if (pct < 15) return 'clear — flat sky';
  if (pct < 40) return 'some cloud — good';
  if (pct < 75) return 'broken cloud — best';
  return 'overcast — soft light';
}

function moonGlyph(illumination: number, phase: string): string {
  if (phase === 'New moon') return '🌑';
  if (phase === 'Full moon') return '🌕';
  const waxing = phase.startsWith('Waxing') || phase === 'First quarter';
  if (illumination < 35) return waxing ? '🌒' : '🌘';
  if (illumination < 65) return waxing ? '🌓' : '🌗';
  return waxing ? '🌔' : '🌖';
}

function DayBlock({ label, sun, weather, moon }: {
  label: string; sun: SunDay; weather: WeatherDay | null; moon: MoonInfo;
}) {
  return (
    <div className="photo__day">
      <h4>{label}</h4>

      <div className="photo__row photo__row--hero">
        <span className="photo__k">🌅 Golden</span>
        <span className="photo__v">{span(sun.goldenMorning)}</span>
      </div>
      <div className="photo__row photo__row--hero">
        <span className="photo__k">🌇 Golden</span>
        <span className="photo__v">{span(sun.goldenEvening)}</span>
      </div>
      <div className="photo__row">
        <span className="photo__k">🔵 Blue</span>
        <span className="photo__v">{span(sun.blueMorning)}</span>
      </div>
      <div className="photo__row">
        <span className="photo__k">🔵 Blue</span>
        <span className="photo__v">{span(sun.blueEvening)}</span>
      </div>

      <div className="photo__row">
        <span className="photo__k">Sun</span>
        <span className="photo__v">
          {time(sun.sunrise)} – {time(sun.sunset)}
          {sun.dayLength && <span className="photo__sub"> · {sun.dayLength}</span>}
        </span>
      </div>

      {weather && (
        <>
          <div className="photo__row">
            <span className="photo__k">Sky</span>
            <span className="photo__v">
              {weather.summary}
              {weather.tempMin != null && weather.tempMax != null && (
                <span className="photo__sub"> · {Math.round(weather.tempMin)}–{Math.round(weather.tempMax)}°</span>
              )}
            </span>
          </div>
          {weather.cloudCover != null && (
            <div className="photo__row">
              <span className="photo__k">Cloud</span>
              <span className="photo__v">
                {Math.round(weather.cloudCover)}%
                <span className="photo__sub"> · {cloudNote(weather.cloudCover)}</span>
              </span>
            </div>
          )}
          <div className="photo__row">
            <span className="photo__k">Rain / UV</span>
            <span className="photo__v">
              {weather.rainChance != null ? `${weather.rainChance}%` : '—'}
              {weather.uvMax != null && <span className="photo__sub"> · UV {weather.uvMax.toFixed(1)}</span>}
              {weather.windMax != null && <span className="photo__sub"> · {Math.round(weather.windMax)} km/h</span>}
            </span>
          </div>
        </>
      )}

      <div className="photo__row">
        <span className="photo__k">Moon</span>
        <span className="photo__v">
          {moonGlyph(moon.illumination, moon.phase)} {moon.phase}
          <span className="photo__sub"> · {moon.illumination}% lit</span>
        </span>
      </div>
    </div>
  );
}

export default function PhotoConditionsPanel() {
  const [data, setData] = useState<Conditions | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.photo()
        .then((d) => { if (alive) { setData(d); setFailed(false); } })
        .catch(() => { if (alive) setFailed(true); });
    };
    load();
    // The server caches for 20 minutes; this just keeps a long-open tab honest.
    const id = setInterval(load, 15 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (failed) return <aside className="photo"><p className="hint">Conditions unavailable.</p></aside>;
  if (!data) return <aside className="photo"><p className="hint">Loading conditions…</p></aside>;

  return (
    <aside className="photo">
      <div className="photo__head">
        <h3>📷 Conditions</h3>
        {data.location && <span className="photo__where">{data.location.city}</span>}
      </div>

      {data.now && (
        <div className="photo__now">
          <span className="photo__now-temp">{Math.round(data.now.temp ?? 0)}°</span>
          <span className="photo__now-text">
            {data.now.summary}
            {data.now.cloudCover != null && ` · ${data.now.cloudCover}% cloud`}
            {data.now.wind != null && ` · ${Math.round(data.now.wind)} km/h`}
          </span>
        </div>
      )}

      <DayBlock label="Today" sun={data.today.sun} weather={data.today.weather} moon={data.today.moon} />
      <DayBlock label="Tomorrow" sun={data.tomorrow.sun} weather={data.tomorrow.weather} moon={data.tomorrow.moon} />

      {!data.location && (
        <p className="hint">Set a location in Settings for local times and weather.</p>
      )}
      <p className="photo__foot">
        Sun times computed locally · weather from Open-Meteo
      </p>
    </aside>
  );
}
