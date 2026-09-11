import { useEffect, useRef, useState } from 'react';

export interface MultiOption {
  value: string;
  label: string;
  count?: number;
  /** Draw a rule above this one, to set a group of choices apart. */
  divider?: boolean;
}

/**
 * A dropdown of checkboxes, for a filter that can take several values at once.
 *
 * A native <select multiple> is a scrolling box that needs ctrl-click, which
 * nobody discovers; this reads like the single dropdowns beside it until it is
 * opened. Nothing ticked means no filter, the same as "All" did before.
 */
export default function MultiSelect({
  label,
  allLabel,
  options,
  value,
  onChange,
  title,
}: {
  /** Heading inside the open menu. */
  label: string;
  /** What the closed button says when nothing is ticked. */
  allLabel: string;
  options: MultiOption[];
  value: string[];
  onChange: (next: string[]) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  // A ticked value can drop out of the options when the events change under
  // it; it still filters, so it still has to be named on the button.
  const labelOf = (v: string): string => options.find((o) => o.value === v)?.label ?? v;
  const summary =
    value.length === 0 ? allLabel : value.length === 1 ? labelOf(value[0]) : `${labelOf(value[0])} +${value.length - 1}`;
  const toggle = (v: string): void => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <div className="multi" ref={ref}>
      <button
        type="button"
        className={`multi__button${value.length ? ' is-set' : ''}`}
        title={value.length > 1 ? value.map(labelOf).join(', ') : title}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="multi__summary">{summary}</span>
        <span className="multi__caret">▾</span>
      </button>
      {open && (
        <div className="multi__menu">
          <div className="multi__head">
            <span>{label}</span>
            <button type="button" className="multi__clear" disabled={value.length === 0} onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          {options.map((o) => (
            <label key={o.value} className={`multi__option${o.divider ? ' multi__option--divider' : ''}`}>
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
              <span className="multi__label">{o.label}</span>
              {o.count != null && <span className="multi__count">{o.count}</span>}
            </label>
          ))}
          {options.length === 0 && <p className="multi__none">Nothing to choose from yet.</p>}
        </div>
      )}
    </div>
  );
}
