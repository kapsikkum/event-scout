import { useMemo, useState } from 'react';
import { useStore } from '../store';
import EventCard from '../components/EventCard';
import EventDetail from '../components/EventDetail';
import { MergedEvent } from '../api';
import { decodeEntities } from '../text';
import { applyFilters, categoriesOf, DEFAULT_FILTERS, DateChip, Filters, placeLabel, SortKey } from '../filtering';

/**
 * Split the visible list into the sections to render.
 *
 * Only the "By place" sort wants sections; every other sort is one unheaded
 * run, so it returns a single group and the markup stays the same shape either
 * way. The runs are contiguous — the sort has already put a venue's events
 * side by side — so an event never appears under two headings.
 */
function placeGroups(list: MergedEvent[], sort: SortKey): [string, MergedEvent[]][] {
  if (sort !== 'place') return [['', list]];
  const out: [string, MergedEvent[]][] = [];
  for (const ev of list) {
    const place = placeLabel(ev);
    const last = out[out.length - 1];
    if (last && last[0] === place) last[1].push(ev);
    else out.push([place, [ev]]);
  }
  return out;
}

const DATE_CHIPS: { key: DateChip; label: string }[] = [
  { key: 'all', label: 'All upcoming' },
  { key: 'today', label: 'Today' },
  { key: 'weekend', label: 'This weekend' },
  { key: 'week', label: 'Next 7 days' },
  { key: 'month', label: 'This month' },
];

export default function Events() {
  const { events, settings, status } = useStore();
  const { mergeGroups } = useStore();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [open, setOpen] = useState<MergedEvent | null>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [mergeNote, setMergeNote] = useState('');
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const togglePick = (group: string, on: boolean): void =>
    setPicked((prev) => (on ? [...new Set([...prev, group])] : prev.filter((g) => g !== group)));

  const doMerge = async (): Promise<void> => {
    if (picked.length < 2) return;
    setMergeNote('');
    try {
      await mergeGroups(picked);
      setMergeNote(`Merged ${picked.length} events into one.`);
      setPicked([]);
      setPicking(false);
    } catch (err) {
      setMergeNote((err as Error).message);
    }
  };

  const filtered = useMemo(() => applyFilters(events, filters, settings), [events, filters, settings]);
  const categories = useMemo(() => categoriesOf(events), [events]);
  const sourceNames = useMemo(
    () => (status ? status.sources.filter((s) => s.state === 'ok' || s.count > 0).map((s) => s.name) : []),
    [status]
  );
  const starredCount = events.filter((e) => e.starred).length;

  return (
    <>
      <div className="filterbar">
        <input
          className="search"
          placeholder="Search events, venues…"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
        />
        <div className="chiprow">
          {DATE_CHIPS.map((c) => (
            <button
              key={c.key}
              className={`chip ${filters.dateChip === c.key ? 'active' : ''}`}
              onClick={() => set({ dateChip: c.key })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <select value={filters.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={filters.source} onChange={(e) => set({ source: e.target.value })}>
          <option value="">All sources</option>
          {sourceNames.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={filters.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
          <option value="date">Soonest first</option>
          <option value="photo">Best for photos</option>
          <option value="distance">Nearest first</option>
          <option value="place">By place</option>
        </select>
        <label className="toggle">
          <input type="checkbox" checked={filters.hideOnline} onChange={(e) => set({ hideOnline: e.target.checked })} />
          Hide online
        </label>
        <label className="toggle">
          <input type="checkbox" checked={filters.starredOnly} onChange={(e) => set({ starredOnly: e.target.checked })} />
          ★ Shortlist only
        </label>
        <label className="toggle">
          <input type="checkbox" checked={filters.showHidden} onChange={(e) => set({ showHidden: e.target.checked })} />
          Show removed
        </label>
        {starredCount > 0 && (
          <a href="/api/export.ics" download>
            Export shortlist (.ics)
          </a>
        )}
        <button
          className={picking ? 'primary' : ''}
          title="Combine duplicate listings into one event"
          onClick={() => {
            setPicking((p) => !p);
            setPicked([]);
            setMergeNote('');
          }}
        >
          {picking ? 'Cancel merge' : '⧉ Merge'}
        </button>
      </div>

      {picking && (
        <div className="mergebar">
          <span>
            {picked.length === 0
              ? 'Tick two or more listings of the same event.'
              : `${picked.length} selected`}
          </span>
          <button className="primary" disabled={picked.length < 2} onClick={() => void doMerge()}>
            Merge {picked.length > 1 ? picked.length : ''}
          </button>
          <span className="mergebar__note">
            The merged event keeps every source link, the longest description and
            the first available image — so a listing with no picture inherits one.
          </span>
        </div>
      )}

      {mergeNote && <div className="banner">{mergeNote}</div>}

      <div className="count">
        {filtered.length} of {events.length} events
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          {events.length === 0 ? (
            <>
              <p>No events yet.</p>
              <p>
                Configure your location and at least one source in <a href="/settings">Settings</a>, then hit Refresh.
              </p>
            </>
          ) : (
            <p>Nothing matches these filters.</p>
          )}
        </div>
      ) : (
        placeGroups(filtered, filters.sort).map(([place, list]) => (
          <section key={place} className="placegroup">
            {filters.sort === 'place' && (
              <h2 className="placegroup__head">
                <span className="placegroup__pin">📍</span>
                {decodeEntities(place) || 'Location unknown'}
                <span className="placegroup__count">{list.length}</span>
              </h2>
            )}
            <div className="grid">
              {list.map((ev) => (
                <EventCard
                  key={ev.group}
                  ev={ev}
                  onOpen={setOpen}
                  selected={picked.includes(ev.group)}
                  onSelect={picking ? togglePick : undefined}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {open && (
        <EventDetail
          // Re-read from the store so star/remove state stays live while open.
          ev={events.find((e) => e.group === open.group) ?? open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
