import { useEffect, useRef, useState } from 'react';
import { api, DensityStatus, EventTopic, GeocodeResult, Settings as SettingsType, SourceStatus } from '../api';
import { useStore } from '../store';

/** Newline, as a constant so the textarea handlers stay readable. */
const LINE_BREAK = String.fromCharCode(10);

/**
 * A textarea for the fields that hold a list.
 *
 * Every one of these parses its contents into a structured list on each
 * keystroke and re-renders from the parse, which quietly eats what is being
 * typed. Entering "Penrith, 25" was impossible: the comma parses to nothing
 * and vanishes before the number after it can be typed, so only letters ever
 * survived. The same round trip drops a newline as an empty entry, so a
 * second line could not be started either.
 *
 * The text is the edit state here, and the parsed value is derived from it.
 * An external change — settings finishing their load, or Reset — is adopted
 * only while the field is not focused, so it can never fight the keyboard.
 * Blurring re-reads the normalised text, which tidies up spacing.
 */
function ListArea({
  text,
  onText,
  rows = 3,
  placeholder,
}: {
  text: string;
  onText: (raw: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(text);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(text);
  }, [text]);

  return (
    <textarea
      rows={rows}
      placeholder={placeholder}
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(text);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onText(e.target.value);
      }}
    />
  );
}

function StatusLine({ status }: { status: SourceStatus | undefined }) {
  if (!status) return null;
  const icon =
    status.state === 'ok' ? '●' : status.state === 'error' ? '✕' : status.state === 'missing_config' ? '!' : '○';
  return (
    <div className={`status-line ${status.state}`}>
      {icon} {status.state === 'ok' ? `${status.message}` : status.message}
      {status.lastFetch && ` (${new Date(status.lastFetch).toLocaleString()})`}
    </div>
  );
}

export default function Settings() {
  const { settings, status, updateSettings, refresh, refreshing } = useStore();
  // Only once it has finished: while it runs the feed is at the top of the
  // page, and showing the same lines twice helps nobody.
  const lastSearch = refreshing ? [] : status?.progress?.lines ?? [];
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [geoQuery, setGeoQuery] = useState('');
  const [density, setDensity] = useState<DensityStatus | null>(null);
  const [densityMsg, setDensityMsg] = useState('');

  // Poll while a sample is in flight; a pass takes minutes.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.densityStatus()
        .then((s) => { if (alive) setDensity(s); })
        .catch(() => { if (alive) setDensity(null); });
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  async function runDensity(action: 'refresh' | 'discover'): Promise<void> {
    setDensityMsg(action === 'refresh' ? 'Sampling venues…' : 'Rebuilding venue list…');
    try {
      const res =
        action === 'refresh' ? await api.densityRefresh() : await api.densityDiscover();
      setDensityMsg(res.message);
    } catch (err) {
      setDensityMsg((err as Error).message);
    }
    api.densityStatus().then(setDensity).catch(() => undefined);
  }
  const [topics, setTopics] = useState<EventTopic[]>([]);
  const [geoResults, setGeoResults] = useState<GeocodeResult[] | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.topics().then((r) => setTopics(r.topics)).catch(() => setTopics([]));
  }, []);

  useEffect(() => {
    if (settings && !draft) {
      setDraft(settings);
      setGeoQuery(settings.city);
    }
  }, [settings, draft]);

  if (!draft) return <p>Loading…</p>;

  const set = (patch: Partial<SettingsType>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setSaved(false);
  };
  const statusFor = (name: string) => status?.sources.find((s) => s.name === name);
  const firstRun = settings?.lat == null;

  const searchCity = async () => {
    if (!geoQuery.trim()) return;
    setGeoBusy(true);
    try {
      setGeoResults(await api.geocode(geoQuery));
    } catch (err) {
      alert(`Geocoding failed: ${(err as Error).message}`);
    } finally {
      setGeoBusy(false);
    }
  };

  const save = async () => {
    await updateSettings(draft);
    setSaved(true);
  };

  const listEditor = (
    label: string,
    values: string[],
    onChange: (next: string[]) => void,
    placeholder: string
  ) => (
    <>
      {values.map((v, i) => (
        <div className="feedrow" key={i}>
          <input
            value={v}
            placeholder={placeholder}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button onClick={() => onChange(values.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...values, ''])}>+ Add {label}</button>
    </>
  );

  return (
    <div className="settings">
      {firstRun && (
        <div className="banner">
          <strong>Welcome to Event Scout!</strong> Set your location below, add API keys for the sources you want
          (each is optional), then hit <em>Save</em> and <em>Refresh</em>.
        </div>
      )}

      <section>
        <h2>📍 Location</h2>
        <p className="hint">Events are searched around this point. Powered by OpenStreetMap geocoding.</p>
        <div className="formrow">
          <label>City / area</label>
          <input
            value={geoQuery}
            placeholder="e.g. Portland, OR"
            onChange={(e) => setGeoQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void searchCity()}
          />
          <button onClick={() => void searchCity()} disabled={geoBusy}>
            {geoBusy ? 'Searching…' : 'Search'}
          </button>
        </div>
        {geoResults && (
          <div className="geocode-results">
            {geoResults.length === 0 && <span className="hint">No matches found.</span>}
            {geoResults.map((r) => (
              <button
                key={`${r.lat},${r.lng}`}
                onClick={() => {
                  set({ city: r.displayName.split(',')[0], lat: r.lat, lng: r.lng });
                  setGeoResults(null);
                }}
              >
                📍 {r.displayName}
              </button>
            ))}
          </div>
        )}
        {draft.lat != null && (
          <div className="status-line ok">
            ● Location set: {draft.city} ({draft.lat.toFixed(4)}, {draft.lng?.toFixed(4)})
          </div>
        )}
        <div className="formrow" style={{ marginTop: 12 }}>
          <label>Radius: {draft.radiusKm} km</label>
          <input
            type="range"
            min={5}
            max={300}
            step={5}
            value={draft.radiusKm}
            onChange={(e) => set({ radiusKm: Number(e.target.value) })}
          />
        </div>

        <label className="hint" style={{ display: 'block', marginTop: 14 }}>
          Also look here — one per line. A name is enough (<code>Penrith</code>); add
          <code> , radiusKm</code> to give it its own reach. Every source runs once per
          area, so a place worth the drive can be watched without widening the radius
          above and dragging in everything in between.
        </label>
        <ListArea
          text={(draft.eventAreas ?? [])
            .map((a) => [a.name, a.radiusKm].filter((v) => v != null && v !== '').join(', '))
            .join(LINE_BREAK)}
          placeholder={'Penrith, 25' + LINE_BREAK + 'Orange'}
          onText={(raw) =>
            set({
              eventAreas: raw
                .split(LINE_BREAK)
                .map((line) => line.split(',').map((p) => p.trim()))
                .filter((parts) => parts[0])
                .map((parts) => ({
                  name: parts[0],
                  radiusKm: parts[1] ? Number(parts[1]) : undefined,
                })),
            })
          }
        />

        <h4 style={{ margin: '16px 0 4px', fontSize: 13 }}>What to look for</h4>
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Each topic expands to a set of search phrases, run against every area. Pick a
          few rather than all: they rotate across refreshes, so everything gets covered
          either way, and fewer at once means faster passes. Your own terms further
          down still apply on top.
        </p>
        <div className="chiprow">
          {topics.map((t) => {
            const on = (draft.eventTopics ?? []).includes(t.key);
            return (
              <button
                key={t.key}
                className={`chip ${on ? 'active' : ''}`}
                title={t.terms.join(' · ')}
                onClick={() =>
                  set({
                    eventTopics: on
                      ? (draft.eventTopics ?? []).filter((k) => k !== t.key)
                      : [...(draft.eventTopics ?? []), t.key],
                  })
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {(draft.eventTopics ?? []).length > 0 && (
          <p className="hint" style={{ marginTop: 8 }}>
            {(draft.eventTopics ?? []).reduce(
              (n, k) => n + (topics.find((t) => t.key === k)?.terms.length ?? 0), 0
            )}{' '}
            phrases across {Math.max(1, (draft.eventAreas ?? []).length + (draft.lat != null ? 1 : 0))} area(s)
          </p>
        )}
      </section>

      <section>
        <h2>
          📊 Venue density
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.densityEnabled === true}
              onChange={(e) => set({ densityEnabled: e.target.checked })}
            />{' '}
            Enabled
          </label>
        </h2>
        <p className="hint">
          Samples how busy local venues are, on its own schedule alongside the event sources.
          Each pass opens one page per venue, so keep the interval relaxed.
        </p>

        <div className="formrow" style={{ marginTop: 12 }}>
          <label>Every: {draft.densityIntervalMinutes ?? 60} min</label>
          <input
            type="range"
            min={15}
            max={240}
            step={15}
            value={draft.densityIntervalMinutes ?? 60}
            onChange={(e) => set({ densityIntervalMinutes: Number(e.target.value) })}
          />
        </div>

        <label className="hint">
          Areas — one per line as <code>Name, lat, lng, radiusKm</code>. Leave blank to use the
          location above.
        </label>
        <ListArea
          text={(draft.densityAreas ?? [])
            .map((a) => [a.name, a.lat, a.lng, a.radiusKm].filter((v) => v != null && v !== '').join(', '))
            .join(LINE_BREAK)}
          placeholder="Bathurst, -33.4300, 149.5750, 5.5"
          onText={(raw) =>
            set({
              densityAreas: raw
                .split(LINE_BREAK)
                .map((line) => line.split(',').map((p) => p.trim()))
                .filter((parts) => parts[0])
                .map((parts) => ({
                  name: parts[0],
                  lat: parts[1] ? Number(parts[1]) : undefined,
                  lng: parts[2] ? Number(parts[2]) : undefined,
                  radiusKm: parts[3] ? Number(parts[3]) : undefined,
                })),
            })
          }
        />

        <div className="formrow" style={{ marginTop: 10 }}>
          <label>Max venues</label>
          <input
            type="number"
            min={0}
            step={5}
            value={draft.densityMaxVenues ?? 30}
            onChange={(e) => set({ densityMaxVenues: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          <b>0 tracks every place found.</b> Each venue is one page load, so this is a
          time budget rather than a limit — around 10 seconds each, and the hourly run
          skips itself while one is still going.
        </p>

        <label className="hint" style={{ display: 'block', marginTop: 10 }}>
          Always include these venues — a name, or a Google Maps link. A link pins
          exactly one place, which a name cannot: searching{' '}
          <code>Mount Panorama</code> returns the mountain, the reserve and the
          circuit, and only one of them carries busyness data.
        </label>
        <ListArea
          text={(draft.densityPlaces ?? []).join(LINE_BREAK)}
          placeholder={'Mount Panorama' + LINE_BREAK + 'https://maps.app.goo.gl/…'}
          onText={(raw) =>
            set({ densityPlaces: raw.split(LINE_BREAK).map((v) => v.trim()).filter(Boolean) })
          }
        />

        {density && (
          <div className={`status-line ${density.running ? 'never_run' : 'ok'}`}>
            {density.running
              ? '○ Sampling now…'
              : `● ${density.lastResult ?? 'not sampled yet'}${
                  density.lastRun ? ` (${new Date(density.lastRun).toLocaleString()})` : ''
                }`}
          </div>
        )}

        {density && density.areas.length > 0 && (
          <p className="map-panel__meta" style={{ marginTop: 6 }}>
            {density.areas
              .map((a) => `${a.name}: ${a.venues} venues, ${a.withProfile} profiled`)
              .join(' · ')}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="ghost" disabled={density?.running} onClick={() => runDensity('refresh')}>
            Sample now
          </button>
          <button className="ghost" disabled={density?.running} onClick={() => runDensity('discover')}>
            Rebuild venue list
          </button>
        </div>
        {densityMsg && <p className="hint" style={{ marginTop: 8 }}>{densityMsg}</p>}
      </section>

      {lastSearch.length > 0 && (
        <section>
          <h2>🔎 Last search</h2>
          <p className="hint" style={{ margin: '0 0 8px' }}>
            What the most recent refresh did and what it turned up. It runs at the
            top of the page while it is happening; this is where it ends up
            afterwards.
          </p>
          <div className="activity__feed" style={{ maxHeight: 220 }}>
            {lastSearch.map((line, i) => (
              <div key={i} className="activity__line">
                {line}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>
          🎫 Ticketmaster
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.ticketmaster !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, ticketmaster: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Concerts, sports, theater. Free key (5,000 calls/day) from{' '}
          <a href="https://developer.ticketmaster.com/" target="_blank" rel="noreferrer">
            developer.ticketmaster.com
          </a>
          .
        </p>
        <div className="formrow">
          <label>API key</label>
          <input value={draft.ticketmasterKey} onChange={(e) => set({ ticketmasterKey: e.target.value })} />
        </div>
        <StatusLine status={statusFor('ticketmaster')} />
      </section>

      <section>
        <h2>
          🪑 SeatGeek
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.seatgeek !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, seatgeek: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Concerts and sports, often complements Ticketmaster. Free client ID from{' '}
          <a href="https://seatgeek.com/account/develop" target="_blank" rel="noreferrer">
            seatgeek.com/account/develop
          </a>
          .
        </p>
        <div className="formrow">
          <label>Client ID</label>
          <input value={draft.seatgeekClientId} onChange={(e) => set({ seatgeekClientId: e.target.value })} />
        </div>
        <StatusLine status={statusFor('seatgeek')} />
      </section>

      <section>
        <h2>
          🎟 Eventbrite
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.eventbrite !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, eventbrite: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Eventbrite removed public search, so this follows specific organizers. Get a private token at{' '}
          <a href="https://www.eventbrite.com/platform/api-keys" target="_blank" rel="noreferrer">
            eventbrite.com/platform/api-keys
          </a>
          . Organizer IDs are the number in an organizer page URL (eventbrite.com/o/name-<strong>1234567890</strong>).
        </p>
        <div className="formrow">
          <label>Private token</label>
          <input value={draft.eventbriteToken} onChange={(e) => set({ eventbriteToken: e.target.value })} />
        </div>
        <label className="hint">Organizer IDs</label>
        {listEditor('organizer', draft.eventbriteOrganizerIds, (v) => set({ eventbriteOrganizerIds: v }), '1234567890')}
        <StatusLine status={statusFor('eventbrite')} />
      </section>

      <section>
        <h2>
          📘 Facebook <span className="badge unofficial">unofficial</span>
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.facebook !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, facebook: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Scrapes public Facebook event pages — this violates Meta's terms of service and can break at any time. Works
          far better with a logged-in cookie: open facebook.com → DevTools (F12) → Application → Cookies → copy the{' '}
          <code>c_user</code> and <code>xs</code> values as <code>c_user=…; xs=…</code>. Consider a throwaway account.
        </p>
        <div className="formrow">
          <label>Cookie</label>
          <input
            value={draft.fbCookie}
            placeholder="c_user=100000000000000; xs=abc123…"
            onChange={(e) => set({ fbCookie: e.target.value })}
          />
        </div>
        <label className="hint">Search terms (defaults to your city if empty)</label>
        {listEditor('search term', draft.fbSearchTerms, (v) => set({ fbSearchTerms: v }), 'e.g. Portland events')}
        <label className="hint" style={{ display: 'block', marginTop: 10 }}>
          Pages / venues to follow (name or URL)
        </label>
        {listEditor('page', draft.fbPages, (v) => set({ fbPages: v }), 'e.g. crystalballroompdx')}
        <StatusLine status={statusFor('facebook')} />
      </section>

      <section>
        <h2>
          🔎 Web search <span className="badge unofficial">unofficial</span>
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.websearch !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, websearch: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Searches DuckDuckGo, Bing and Mojeek, follows the top results, and reads
          structured <code>schema.org/Event</code> data out of the pages it lands on.
          No key needed. This is the source that finds the things nobody lists on a
          ticketing site — car club runs, council calendars, showground programmes,
          pub gig listings.
        </p>
        <p className="hint">
          Queries come from the <b>topics</b> you picked under Location, run against
          every area. Search engines quietly return empty pages rather than errors when
          pushed too hard, so a refresh spends a fixed budget spread across areas and
          rotates through the rest next time. Large aggregators that block scraping are
          skipped automatically.
        </p>
        <label className="hint">Extra search terms — added to whatever the topics produce</label>
        {listEditor(
          'search term',
          draft.webSearchTerms,
          (v) => set({ webSearchTerms: v }),
          'e.g. Bathurst 1000 support events'
        )}
        <StatusLine status={statusFor('websearch')} />
      </section>

      <section>
        <h2>
          📅 Calendar feeds (iCal)
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={draft.enabledSources.ical !== false}
              onChange={(e) => set({ enabledSources: { ...draft.enabledSources, ical: e.target.checked } })}
            />{' '}
            enabled
          </label>
        </h2>
        <p className="hint">
          Many city tourism sites, parks departments, and venues publish .ics calendar feeds — great for festivals and
          free public events. Paste feed URLs here.
        </p>
        {draft.icalFeeds.map((f, i) => (
          <div className="feedrow" key={i}>
            <input
              style={{ maxWidth: 200 }}
              value={f.name}
              placeholder="Name"
              onChange={(e) =>
                set({ icalFeeds: draft.icalFeeds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
              }
            />
            <input
              value={f.url}
              placeholder="https://…/events.ics"
              onChange={(e) =>
                set({ icalFeeds: draft.icalFeeds.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })
              }
            />
            <button onClick={() => set({ icalFeeds: draft.icalFeeds.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <button onClick={() => set({ icalFeeds: [...draft.icalFeeds, { name: '', url: '' }] })}>+ Add feed</button>
        <StatusLine status={statusFor('ical')} />
      </section>

      <div className="savebar">
        <button className="primary" onClick={() => void save()}>
          Save settings
        </button>
        <button onClick={() => void save().then(() => refresh())} disabled={refreshing || draft.lat == null}>
          {refreshing ? 'Refreshing…' : 'Save & refresh now'}
        </button>
        <span className="note">{saved ? '✓ Saved' : 'Unsaved changes are lost on reload'}</span>
      </div>
    </div>
  );
}
