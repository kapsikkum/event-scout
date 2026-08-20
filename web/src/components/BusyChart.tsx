import { useEffect, useRef, useState } from 'react';
import { busyColour } from '../busy';

/**
 * Hourly busyness as inline SVG — no charting library.
 *
 * Bars are Google's typical profile for the day; dots are what we actually
 * measured at that hour. The gap between them is the point: a dot well above
 * the bar means something is happening that isn't normal for the time.
 *
 * The chart is drawn in real pixels rather than in a fixed viewBox stretched to
 * fit. Stretching distorts anything that isn't a rectangle — measured dots came
 * out as flat ovals and the hour labels as unreadable smears — and there is no
 * SVG-side fix for that, since `preserveAspectRatio` cannot be applied per
 * element. Measuring the container costs one ResizeObserver.
 */

export interface BusyChartProps {
  /** Typical percentage keyed by hour, as stored in the weekly profile. */
  hours: Record<string, number>;
  /** Optional observed averages keyed by hour. */
  observed?: Record<number, { avg: number; samples: number }>;
  /** Highlight this hour, e.g. the current one. */
  markHour?: number | null;
  height?: number;
  showAxis?: boolean;
}

export default function BusyChart({
  hours, observed, markHour, height = 92, showAxis = true,
}: BusyChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const entries = Object.entries(hours)
    .map(([h, pct]) => ({ hour: Number(h), pct }))
    .sort((a, b) => a.hour - b.hour);

  if (entries.length === 0) {
    return <p className="chart__empty">No profile for this day</p>;
  }

  const first = entries[0].hour;
  const last = entries[entries.length - 1].hour;
  const span = Math.max(1, last - first + 1);

  const axisH = showAxis ? 16 : 0;
  const plot = height - axisH;
  const barW = width / span;
  const y = (pct: number) => plot - (pct / 100) * plot;
  const x = (hour: number) => (hour - first) * barW;

  return (
    <div className="chart" ref={box}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Busyness by hour, ${first}:00 to ${last}:00`}
      >
        {/* A tick under the axis, not a column behind the bars: a pale full-height
            column is indistinguishable from a bar of that height. */}
        {markHour != null && markHour >= first && markHour <= last && (
          <rect
            x={x(markHour) + barW * 0.14}
            y={plot + 1}
            width={Math.max(2, barW * 0.72)}
            height={2}
            className="chart__now"
          />
        )}

        {entries.map(({ hour, pct }) => (
          <rect
            key={hour}
            x={x(hour) + barW * 0.14}
            y={y(pct)}
            width={Math.max(1, barW * 0.72)}
            height={Math.max(1, plot - y(pct))}
            rx={Math.min(2, barW * 0.2)}
            fill={busyColour(pct / 100)}
            opacity={markHour === hour ? 1 : 0.75}
          >
            <title>{`${hour}:00 — ${pct}% typical`}</title>
          </rect>
        ))}

        {observed &&
          Object.entries(observed)
            .map(([h, o]) => ({ hour: Number(h), ...o }))
            .filter((o) => o.hour >= first && o.hour <= last)
            .map((o) => (
              <circle
                key={`obs-${o.hour}`}
                cx={x(o.hour) + barW / 2}
                cy={y(o.avg)}
                r={3.5}
                className="chart__dot"
              >
                <title>
                  {`${o.hour}:00 — measured ${o.avg}% (${o.samples} sample${o.samples === 1 ? '' : 's'})`}
                </title>
              </circle>
            ))}

        {showAxis &&
          entries
            .filter((e) => e.hour % 3 === 0)
            .map(({ hour }) => (
              <text
                key={`ax-${hour}`}
                x={x(hour) + barW / 2}
                y={height - 4}
                className="chart__axis"
                textAnchor="middle"
              >
                {hour}
              </text>
            ))}
      </svg>
    </div>
  );
}
