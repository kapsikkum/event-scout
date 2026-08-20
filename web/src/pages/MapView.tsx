import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useStore } from '../store';
import { formatWhen } from '../components/EventCard';
import { api, DensityArea, DensityGeoJson, VenueReading } from '../api';
import { busyColour } from '../busy';
import { decodeEntities } from '../text';

// Distinct pin colors keyed by category hash.
const PIN_COLORS = ['#f5a623', '#4cc3ff', '#4ade80', '#f87171', '#c084fc', '#fb923c', '#2dd4bf'];

function colorFor(category: string): string {
  let h = 0;
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PIN_COLORS[h % PIN_COLORS.length];
}

const escape = (s: string): string => s.replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/**
 * Venues can share a name - Bathurst has two "Mount Panorama" entries - so the
 * name alone is not a usable React key: duplicates confuse reconciliation and
 * leave stale rows behind. Coordinates disambiguate them.
 */
const venueKey = (v: VenueReading): string => `${v.name}@${v.lat},${v.lon}`;

export default function MapView() {
  const { events, settings } = useStore();
  const mapRef = useRef<L.Map | null>(null);
  const eventsLayer = useRef<L.LayerGroup | null>(null);
  const densityLayer = useRef<L.LayerGroup | null>(null);
  const venuesLayer = useRef<L.LayerGroup | null>(null);

  const [areas, setAreas] = useState<DensityArea[]>([]);
  const [area, setArea] = useState<string>('');
  const [density, setDensity] = useState<DensityGeoJson | null>(null);
  const [venues, setVenues] = useState<VenueReading[]>([]);
  const [note, setNote] = useState<string>('');
  const [filter, setFilter] = useState('');

  // --- map bootstrap ---------------------------------------------------------
  useEffect(() => {
    if (mapRef.current) return;
    const center: [number, number] =
      settings?.lat != null && settings.lng != null ? [settings.lat, settings.lng] : [39.5, -98.35];
    const map = L.map('leaflet-map').setView(center, settings?.lat != null ? 10 : 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);

    // Order matters: density sits under venues, which sit under event pins.
    densityLayer.current = L.layerGroup().addTo(map);
    venuesLayer.current = L.layerGroup().addTo(map);
    eventsLayer.current = L.layerGroup().addTo(map);

    // Top-left, under the zoom buttons: top-right is where the info panel sits.
    L.control
      .layers(
        {},
        {
          'Density': densityLayer.current,
          'Venues (live busyness)': venuesLayer.current,
          'Events': eventsLayer.current,
        },
        { collapsed: false, position: 'topleft' }
      )
      .addTo(map);

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- which areas are configured? ------------------------------------------
  useEffect(() => {
    api.densityAreas()
      .then((res) => {
        setAreas(res.areas);
        if (res.areas.length === 0) {
          setNote('No areas configured — set a location under Settings.');
          return;
        }
        // Prefer whichever area matches the configured location.
        const match = res.areas.find(
          (a) => settings?.city && a.name.toLowerCase() === settings.city.toLowerCase()
        );
        setArea((match ?? res.areas[0]).slug);
      })
      .catch(() => setNote('Density data unavailable.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.city]);

  // --- load the selected area's data ----------------------------------------
  useEffect(() => {
    if (!area) return;
    setNote('');
    // Guarded: these resolve after the map has been torn down if the user
    // navigates away mid-load, and drawing into a removed map throws.
    let alive = true;
    api.density(area, '?all=1')
      .then((d) => { if (alive) setDensity(d); })
      .catch(() => {
        if (!alive) return;
        setDensity(null);
        setNote('No samples for this area yet — use "Sample now" under Settings.');
      });
    api.venues(area).then((v) => { if (alive) setVenues(v); }).catch(() => { if (alive) setVenues([]); });
    return () => { alive = false; };
  }, [area]);

  // --- draw density ----------------------------------------------------------
  useEffect(() => {
    const layer = densityLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (!density) return;

    for (const f of density.features) {
      const ring = f.geometry.coordinates[0];
      const lons = ring.map((p) => p[0]);
      const lats = ring.map((p) => p[1]);
      L.rectangle(
        [
          [Math.min(...lats), Math.min(...lons)],
          [Math.max(...lats), Math.max(...lons)],
        ],
        {
          stroke: false,
          fillColor: f.properties.colour,
          fillOpacity: 0.12 + 0.5 * f.properties.score,
          interactive: false,
        }
      ).addTo(layer);
    }
    const map = mapRef.current;
    if (map && density.features.length) {
      const all = density.features.flatMap((f) => f.geometry.coordinates[0]);
      const bounds = L.latLngBounds(all.map((p) => [p[1], p[0]] as [number, number]));
      // Include the events too. The density grid only covers the home area, so
      // fitting to it alone parked events in other areas off-screen entirely.
      for (const ev of events) {
        if (ev.lat != null && ev.lng != null && !ev.hidden) bounds.extend([ev.lat, ev.lng]);
      }
      // Not animated: a pan still in flight when the user navigates away runs
      // its callback against a map that has been removed, which throws
      // "_leaflet_pos of undefined" out of Leaflet's own animation frame.
      map.fitBounds(bounds, { padding: [24, 24], animate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [density]);

  // --- draw venues -----------------------------------------------------------
  useEffect(() => {
    const layer = venuesLayer.current;
    if (!layer) return;
    layer.clearLayers();

    for (const v of venues) {
      const pct = v.live ?? v.typical ?? 0;
      const isLive = v.live != null;
      const marker = L.circleMarker([v.lat, v.lon], {
        radius: 6 + 8 * v.score,
        color: isLive ? '#ffffff' : 'rgba(255,255,255,0.35)',
        weight: isLive ? 2 : 1,
        fillColor: busyColour(v.score),
        fillOpacity: 0.85,
      });

      // Events happening at this venue, matched by name or proximity.
      const here = events.filter(
        (ev) =>
          !ev.hidden &&
          ((ev.venueName && ev.venueName.toLowerCase() === v.name.toLowerCase()) ||
            (ev.lat != null && ev.lng != null &&
              Math.abs(ev.lat - v.lat) < 0.0012 && Math.abs(ev.lng - v.lon) < 0.0012))
      );

      marker.bindPopup(
        `<strong>${escape(v.name)}</strong><br/>` +
          (isLive
            ? `<span style="color:${busyColour(v.score)}">● ${pct}% busy now</span>` +
              (v.typical != null ? ` <span style="opacity:.7">(usually ${v.typical}%)</span>` : '')
            : `<span style="opacity:.7">${pct}% typical for this hour</span>`) +
          (v.busiestDay
            ? `<br/><span style="opacity:.7">Busiest ${escape(v.busiestDay)}` +
              (v.busiestHour != null ? ` around ${v.busiestHour}:00` : '') +
              (v.quietestDay ? ` · quietest ${escape(v.quietestDay)}` : '') +
              `</span>`
            : '') +
          (here.length
            ? `<hr style="opacity:.2;margin:6px 0"/><strong>${here.length} event${here.length === 1 ? '' : 's'} here</strong><br/>` +
              here
                .slice(0, 4)
                .map((ev) => `${escape(decodeEntities(ev.title))}<br/><span style="opacity:.7">${escape(formatWhen(ev))}</span>`)
                .join('<br/>')
            : '')
      );
      marker.addTo(layer);
    }
  }, [venues, events]);

  // --- draw events -----------------------------------------------------------
  useEffect(() => {
    const layer = eventsLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const ev of events) {
      if (ev.lat == null || ev.lng == null || ev.hidden) continue;
      const url = ev.sources.find((s) => s.url)?.url;
      const marker = L.circleMarker([ev.lat, ev.lng], {
        radius: ev.starred ? 10 : 7,
        color: ev.starred ? '#f5a623' : colorFor(ev.category),
        fillColor: colorFor(ev.category),
        fillOpacity: 0.75,
        weight: ev.starred ? 3 : 1.5,
      });
      marker.bindPopup(
        `<strong>${escape(decodeEntities(ev.title))}</strong><br/>` +
          `${escape(formatWhen(ev))}<br/>` +
          (ev.category ? `<span style="opacity:.7">${escape(ev.category)}</span><br/>` : '') +
          `${escape(decodeEntities(ev.venueName || ev.address || ''))}<br/>` +
          (url ? `<a href="${url}" target="_blank" rel="noreferrer">Open event page</a>` : '')
      );
      marker.addTo(layer);
    }
  }, [events]);

  // Live readings first, then typical, then unsampled - busiest at the top of
  // each band, so the list reads as "what's actually happening" downwards.
  const shown = venues
    .filter((v) => v.name.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => {
      const rank = (v: VenueReading) => (v.live != null ? 0 : v.typical != null ? 1 : 2);
      return rank(a) - rank(b) || (b.live ?? b.typical ?? 0) - (a.live ?? a.typical ?? 0);
    });
  const selected = areas.find((a) => a.slug === area);

  const focusVenue = (v: VenueReading): void => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([v.lat, v.lon], 17);
    // Open the matching marker's popup so the profile is one click away.
    venuesLayer.current?.eachLayer((layer) => {
      const m = layer as L.CircleMarker;
      const ll = m.getLatLng?.();
      if (ll && Math.abs(ll.lat - v.lat) < 1e-9 && Math.abs(ll.lng - v.lon) < 1e-9) m.openPopup();
    });
  };

  return (
    <div className="mapwrap">
      <div id="leaflet-map" />

      <div className="map-panel">
        {areas.length > 1 && (
          <select value={area} onChange={(e) => setArea(e.target.value)} className="map-panel__city">
            {areas.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name}
              </option>
            ))}
          </select>
        )}

        {note && <p className="map-panel__note">{note}</p>}

        {density && (
          <p className="map-panel__meta">
            {density.metadata.observations.toLocaleString()} observations ·{' '}
            {density.metadata.snapshots} snapshot{density.metadata.snapshots === 1 ? '' : 's'}
          </p>
        )}

        {venues.length > 0 && (
          <>
            <h4>
              All places
              <span className="map-panel__count">{shown.length}/{venues.length}</span>
            </h4>
            <input
              className="map-panel__filter"
              value={filter}
              placeholder="Filter places…"
              onChange={(e) => setFilter(e.target.value)}
            />
            <ul className="map-panel__list map-panel__list--all">
              {shown.map((v) => (
                <li
                  key={venueKey(v)}
                  className={v.live != null ? 'is-live' : ''}
                  onClick={() => focusVenue(v)}
                  title={
                    v.busiestDay
                      ? `Busiest ${v.busiestDay}${v.busiestHour != null ? ` around ${v.busiestHour}:00` : ''}`
                      : 'No weekly profile'
                  }
                >
                  <span className="dot" style={{ background: busyColour(v.score) }} />
                  <span className="map-panel__name">{v.name}</span>
                  <span className="map-panel__pct">
                    {v.live != null ? `${v.live}%` : v.typical != null ? `~${v.typical}%` : '–'}
                  </span>
                </li>
              ))}
              {shown.length === 0 && <li className="map-panel__empty">No matches</li>}
            </ul>
            <p className="map-panel__legend">
              <b>%</b> live · <b>~%</b> typical for this hour · click to zoom
            </p>
          </>
        )}

        {selected && selected.venues === 0 && (
          <p className="map-panel__note">
            No venues tracked for {selected.name} yet — use <b>Rebuild venue list</b> under Settings.
          </p>
        )}
      </div>
    </div>
  );
}
