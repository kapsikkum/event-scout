import { useEffect, useState } from 'react';
import { api, FoundBy, ImportCandidate, ImportPreview, MergedEvent, Unauthorized } from '../api';
import { useStore } from '../store';

/**
 * "Add from a link": paste an address, check what was read off it, save.
 *
 * Like a recipe manager's import. The server reads the page and says where each
 * field came from; a field read from loose text or guessed by the model is
 * marked, because those are the ones worth a second look before saving.
 */

const FOUND_LABEL: Record<FoundBy, string> = {
  'json-ld': 'from the page’s event data',
  facebook: 'from Facebook',
  instagram: 'from the Instagram caption',
  page: 'from the page',
  text: 'read from the page’s text — check it',
  model: 'suggested by the local model — check it',
};
const SHAKY: FoundBy[] = ['text', 'model', 'instagram'];

interface Form {
  url: string;
  title: string;
  description: string;
  date: string;
  time: string;
  end: string;
  venueName: string;
  address: string;
  imageUrl: string;
  priceText: string;
  category: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const dayOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockOf = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function formFrom(c: ImportCandidate): Form {
  const start = c.startTime ? new Date(c.startTime) : null;
  const end = c.endTime ? new Date(c.endTime) : null;
  return {
    url: c.url,
    title: c.title,
    description: c.description,
    date: start ? dayOf(start) : '',
    time: start && !c.dateOnly ? clockOf(start) : '',
    end: end ? `${dayOf(end)}T${clockOf(end)}` : '',
    venueName: c.venueName,
    address: c.address,
    imageUrl: c.imageUrl,
    priceText: c.priceText,
    category: '',
  };
}

function Found({ by }: { by?: FoundBy }) {
  if (!by) return null;
  return <span className={`importdlg__found${SHAKY.includes(by) ? ' is-shaky' : ''}`}>{FOUND_LABEL[by]}</span>;
}

export default function ImportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (ev: MergedEvent | null) => void }) {
  const { loadEvents, requestSignIn } = useStore();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [picked, setPicked] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    api.topics().then((r) => setCategories(r.categories ?? [])).catch(() => undefined);
  }, []);

  const candidate = preview?.candidates[picked];
  const set = (patch: Partial<Form>): void => setForm((f) => (f ? { ...f, ...patch } : f));

  const read = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setPreview(null);
    setForm(null);
    try {
      const got = await api.importPreview(url.trim());
      setPreview(got);
      setPicked(0);
      // Nothing read at all still gets a form, so the event can be typed in.
      setForm(formFrom(got.candidates[0] ?? {
        title: '', description: '', startTime: '', dateOnly: false, endTime: '', venueName: '', address: '',
        lat: null, lng: null, url: url.trim(), imageUrl: '', priceText: '', found: {},
      }));
    } catch (err) {
      if (err instanceof Unauthorized) requestSignIn();
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (i: number): void => {
    setPicked(i);
    if (preview?.candidates[i]) setForm(formFrom(preview.candidates[i]));
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    if (!form.title.trim()) return setError('It needs a title.');
    if (!form.date) return setError('It needs a date.');
    const start = new Date(`${form.date}T${form.time || '00:00'}`);
    setBusy(true);
    setError('');
    try {
      const saved = await api.importEvent({
        url: form.url.trim(),
        title: form.title.trim(),
        description: form.description.trim(),
        startTime: start.toISOString(),
        dateOnly: !form.time,
        endTime: form.end ? new Date(form.end).toISOString() : '',
        venueName: form.venueName.trim(),
        address: form.address.trim(),
        imageUrl: form.imageUrl.trim(),
        priceText: form.priceText.trim(),
        category: form.category,
      });
      await loadEvents();
      onSaved(saved.event);
    } catch (err) {
      if (err instanceof Unauthorized) requestSignIn();
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const noPlace = form && !form.venueName.trim() && !form.address.trim();

  return (
    <div className="detail__backdrop" onClick={onClose} role="presentation">
      <div className="detail importdlg" role="dialog" aria-label="Add an event from a link" onClick={(e) => e.stopPropagation()}>
        <button className="detail__close" onClick={onClose} aria-label="Close">✕</button>
        <h2>＋ Add from a link</h2>
        <p className="hint">
          A venue’s event page, a club’s post on Instagram, a Facebook event. It is read for the date and
          details, and nothing is kept until you save.
        </p>
        <div className="formrow">
          <input
            autoFocus
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && url.trim() && void read()}
          />
          <button className="primary" disabled={busy || !/^https?:\/\/\S+$/i.test(url.trim())} onClick={() => void read()}>
            {busy && !form ? 'Reading…' : 'Read'}
          </button>
        </div>

        {preview && <div className={`status-line ${preview.ok ? 'ok' : 'error'}`}>{preview.message}</div>}

        {preview && preview.candidates.length > 1 && (
          <div className="formrow">
            <label>Which one</label>
            <select value={picked} onChange={(e) => pick(Number(e.target.value))}>
              {preview.candidates.map((c, i) => (
                <option key={i} value={i}>
                  {c.startTime ? new Date(c.startTime).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '?'} — {c.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {form && (
          <div className="importdlg__form">
            {form.imageUrl && <img className="importdlg__image" src={form.imageUrl} alt="" referrerPolicy="no-referrer" />}
            <label>Title <Found by={candidate?.found.title} /></label>
            <input value={form.title} onChange={(e) => set({ title: e.target.value })} />

            <div className="importdlg__row">
              <div>
                <label>Date <Found by={candidate?.found.startTime} /></label>
                <input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />
              </div>
              <div>
                <label>Time <span className="hint">(blank for the day only)</span></label>
                <input type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
              </div>
              <div>
                <label>Ends <Found by={candidate?.found.endTime} /></label>
                <input type="datetime-local" value={form.end} onChange={(e) => set({ end: e.target.value })} />
              </div>
            </div>

            <div className="importdlg__row">
              <div>
                <label>Venue <Found by={candidate?.found.venueName} /></label>
                <input value={form.venueName} onChange={(e) => set({ venueName: e.target.value })} />
              </div>
              <div>
                <label>Address or town <Found by={candidate?.found.address} /></label>
                <input value={form.address} onChange={(e) => set({ address: e.target.value })} />
              </div>
            </div>
            {noPlace && (
              <p className="hint">No place given: it will show as <em>Unknown location</em>, and is never hidden for being outside your areas.</p>
            )}

            <label>Description <Found by={candidate?.found.description} /></label>
            <textarea rows={5} value={form.description} onChange={(e) => set({ description: e.target.value })} />

            <div className="importdlg__row">
              <div>
                <label>Category</label>
                <select value={form.category} onChange={(e) => set({ category: e.target.value })}>
                  <option value="">Work it out</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label>Price</label>
                <input value={form.priceText} placeholder="Free, $20…" onChange={(e) => set({ priceText: e.target.value })} />
              </div>
            </div>
            <label>Image address <Found by={candidate?.found.imageUrl} /></label>
            <input value={form.imageUrl} onChange={(e) => set({ imageUrl: e.target.value })} />
            <label>Link</label>
            <input value={form.url} onChange={(e) => set({ url: e.target.value })} />

            {error && <div className="status-line error">{error}</div>}
            <div className="importdlg__actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save event'}
              </button>
            </div>
          </div>
        )}
        {!form && error && <div className="status-line error">{error}</div>}
      </div>
    </div>
  );
}
