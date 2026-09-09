import { useState } from 'react';
import { EventEdit, MergedEvent } from '../api';
import { useStore } from '../store';

/**
 * Changing an event by hand.
 *
 * The last word on a listing, and often the only one that can be right. A
 * scraper takes what the page says, the flyer says whatever the organiser put
 * on it — for the Bathurst 1000 that is a series graphic advertising two rounds
 * at two different circuits — and the model only rearranges what it was given.
 * None of them can know that the venue is Mount Panorama and the picture is
 * wrong. A person looking at it can.
 *
 * Each field shows what is on the card now, so saving an untouched form changes
 * nothing. Clearing a field drops the override and puts back whatever would
 * have been shown, which is why Revert is per field rather than all-or-nothing.
 */

interface Field {
  key: keyof EventEdit;
  label: string;
  hint?: string;
  type?: 'text' | 'textarea' | 'datetime-local' | 'number' | 'url';
}

const FIELDS: Field[] = [
  { key: 'title', label: 'Title' },
  { key: 'startTime', label: 'Starts', type: 'datetime-local' },
  { key: 'venueName', label: 'Venue' },
  { key: 'address', label: 'Address' },
  { key: 'category', label: 'Category' },
  { key: 'priceText', label: 'Price' },
  { key: 'photoScore', label: 'Photo score', type: 'number', hint: '0–100' },
  { key: 'imageUrl', label: 'Image', type: 'url', hint: 'Paste a picture address, or clear it to use the listing’s own' },
  { key: 'description', label: 'Description', type: 'textarea' },
];

/**
 * An ISO instant as the local wall time an input wants.
 *
 * `toISOString` would hand back UTC and the box would show a time nobody
 * recognises — the same confusion that had events summarised as starting at
 * 23:00 the day before.
 */
function toLocalInput(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function initialFor(ev: MergedEvent, key: keyof EventEdit): string {
  if (key === 'startTime') return toLocalInput(ev.startTime);
  if (key === 'photoScore') return String(Math.round(ev.photoScore));
  return String((ev as unknown as Record<string, unknown>)[key] ?? '');
}

export default function EventEditor({ ev, onDone }: { ev: MergedEvent; onDone: () => void }) {
  const { editEvent } = useStore();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, initialFor(ev, f.key)]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const edited = new Set(ev.edited ?? []);
  const dirty = FIELDS.some((f) => draft[f.key] !== initialFor(ev, f.key));

  const save = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      // Only what actually changed, so an untouched field never becomes an
      // override pinned to the value it happened to be showing.
      const patch: EventEdit = {};
      for (const f of FIELDS) {
        const now = draft[f.key];
        if (now === initialFor(ev, f.key)) continue;
        if (f.key === 'photoScore') {
          (patch as Record<string, unknown>).photoScore = now === '' ? null : Number(now);
        } else {
          (patch as Record<string, unknown>)[f.key] = now;
        }
      }
      if (Object.keys(patch).length > 0) await editEvent(ev.group, patch);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const revert = async (key: keyof EventEdit): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      await editEvent(ev.group, { [key]: null } as EventEdit);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor">
      <h4>&#9998; Editing this event</h4>
      <p className="hint">
        What you type here wins over the listing, the flyer and the model. Clear a
        field to go back to what they said.
      </p>

      {FIELDS.map((f) => (
        <div className="editor__row" key={f.key}>
          <label htmlFor={`edit-${f.key}`}>
            {f.label}
            {edited.has(f.key) && (
              <button className="linky editor__revert" onClick={() => void revert(f.key)} disabled={saving}>
                revert
              </button>
            )}
          </label>
          {f.type === 'textarea' ? (
            <textarea
              id={`edit-${f.key}`}
              rows={4}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          ) : (
            <input
              id={`edit-${f.key}`}
              type={f.type === 'number' ? 'number' : f.type === 'datetime-local' ? 'datetime-local' : 'text'}
              min={f.type === 'number' ? 0 : undefined}
              max={f.type === 'number' ? 100 : undefined}
              placeholder={f.hint}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          )}
        </div>
      ))}

      {error && <p className="hint" style={{ color: 'var(--red)' }}>{error}</p>}
      <div className="editor__actions">
        <button className="primary" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button className="ghost" onClick={onDone} disabled={saving}>
          Cancel
        </button>
        {!dirty && <span className="hint">Nothing changed yet.</span>}
      </div>
    </div>
  );
}
