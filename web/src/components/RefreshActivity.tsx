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
 * It shows only while a run is happening. Left on screen afterwards it became
 * a banner on every page of the app that never went away, which is a poor
 * trade for information that is only interesting once. The finished log lives
 * on the Settings page, next to the per-source status it belongs with.
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

  if (!refreshing || !progress?.startedAt || progress.lines.length === 0) return null;

  const active = Object.entries(progress.active);
  const lines = progress.lines.slice(-6);

  return (
    <section className="activity is-running">
      <header className="activity__head">
        <span className="activity__state">
          <span className="spin">⟳</span> Searching
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
