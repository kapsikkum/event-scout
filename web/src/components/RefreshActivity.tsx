import { useEffect, useRef } from 'react';
import { useStore } from '../store';

/**
 * What the refresh is doing, while it does it.
 *
 * A refresh is one long request — six sources across up to three areas, every
 * one of them rate-limited, then a minute of geocoding — and until now the
 * only sign of it was a spinning icon. There was no way to tell a slow source
 * from a stuck one, no sense of how far along it was, and nothing to show for
 * it until the whole thing finished and the list changed underneath you.
 *
 * It stays on screen after the run so the last result can be read, and
 * collapses to a single summary line rather than vanishing.
 */
export default function RefreshActivity() {
  const { status, refreshing } = useStore();
  const progress = status?.progress;
  const feedRef = useRef<HTMLDivElement | null>(null);

  // Follow the tail as lines arrive, the way a log viewer does.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [progress?.lines.length]);

  if (!progress?.startedAt || progress.lines.length === 0) return null;

  const active = Object.entries(progress.active);
  const lines = progress.lines.slice(-6);

  return (
    <section className={`activity${refreshing ? ' is-running' : ''}`}>
      <header className="activity__head">
        <span className="activity__state">
          {refreshing ? <span className="spin">⟳</span> : '✓'}{' '}
          {refreshing ? 'Searching' : 'Last search'}
        </span>
        <span className="activity__found">
          {progress.found} event{progress.found === 1 ? '' : 's'} found
        </span>
        {active.length > 0 && (
          <span className="activity__active">
            {active.map(([name, doing]) => (
              <span key={name} className="activity__chip">
                {name} · {doing}
              </span>
            ))}
          </span>
        )}
      </header>
      <div className="activity__feed" ref={feedRef}>
        {lines.map((line, i) => (
          // Index is a fine key here: the feed is append-only and never
          // reordered, and lines legitimately repeat across areas.
          <div key={i} className="activity__line">
            {line}
          </div>
        ))}
      </div>
    </section>
  );
}
