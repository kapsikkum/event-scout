import { useEffect, useState, type ReactNode } from 'react';
import { api, NotifyStatus, NotifyTarget, Settings as SettingsType } from '../api';

/**
 * Settings → Notifications: Discord webhooks, Matrix rooms, and the Matrix bot.
 *
 * Each target is a place to post with its own triggers and filters, so one
 * webhook can take every new car event while a Matrix room gets a Thursday
 * digest of everything. Webhook addresses and the bot's token are credentials:
 * never read back, blank keeps the stored one, Remove clears it.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const newId = (): string => Math.random().toString(36).slice(2, 10);

function blankTarget(kind: NotifyTarget['kind']): NotifyTarget {
  return {
    id: newId(),
    kind,
    name: kind === 'discord' ? 'Discord' : 'Matrix room',
    enabled: true,
    webhookUrl: '',
    username: '',
    avatarUrl: '',
    mention: '',
    style: 'full',
    showImage: true,
    roomId: '',
    matrixLoud: false,
    commands: true,
    triggers: {
      newEvents: { enabled: true, settleMinutes: 30, maxPerRun: 10 },
      digest: { enabled: false, cadence: 'weekly', weekday: 4, hour: 18, daysAhead: 7 },
      reminders: { enabled: false, hoursBefore: [24, 2] },
      starredChanges: { enabled: false },
    },
    filters: { places: [], categories: [], excludeCategories: [], minPhotoScore: 0, keywords: [], excludeKeywords: [], starredOnly: false },
    quietHours: { enabled: false, from: 22, to: 7 },
  };
}

const csv = (list: (string | number)[]): string => list.join(', ');
const fromCsv = (text: string): string[] => text.split(',').map((s) => s.trim()).filter(Boolean);
const town = (name: string): string => name.split(',')[0].trim().replace(/\s+[A-Z]{2,3}$/, '').trim();

/** A credential box: empty on arrival, blank keeps, Remove clears. */
function Secret({ label, value, isSet, placeholder, onChange }: {
  label: string; value: string | null; isSet: boolean; placeholder: string; onChange: (v: string | null) => void;
}) {
  return (
    <div className="formrow">
      <label>{label}</label>
      <input
        type="password"
        autoComplete="off"
        value={value ?? ''}
        placeholder={value === null ? 'will be removed on save' : isSet ? 'stored — paste to replace' : placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {isSet && value !== null && <button onClick={() => onChange(null)}>Remove</button>}
      {value === null && <button onClick={() => onChange('')}>Keep</button>}
    </div>
  );
}

function Chips({ options, picked, onChange, off }: {
  options: string[]; picked: string[]; onChange: (next: string[]) => void; off?: boolean;
}) {
  return (
    <div className="chiprow">
      {options.map((o) => {
        const on = picked.some((p) => p.toLowerCase() === o.toLowerCase());
        return (
          <button
            key={o}
            className={`chip ${on ? (off ? 'chip--off' : 'active') : ''}`}
            onClick={() => onChange(on ? picked.filter((p) => p.toLowerCase() !== o.toLowerCase()) : [...picked, o])}
          >
            {o === 'unknown' ? 'Unknown location' : o}
          </button>
        );
      })}
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="toggle notify__check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {children}
    </label>
  );
}

function TargetCard({ target, update, remove, places, categories, status, dirty, save, rooms }: {
  rooms: { roomId: string; name: string }[];
  target: NotifyTarget;
  update: (t: NotifyTarget) => void;
  remove: () => void;
  places: string[];
  categories: string[];
  status: NotifyStatus['targets'][string] | undefined;
  dirty: boolean;
  save: () => Promise<void>;
}) {
  const [test, setTest] = useState('');
  const t = target;
  const tr = t.triggers;
  const f = t.filters;
  const set = (patch: Partial<NotifyTarget>): void => update({ ...t, ...patch });
  const trig = <K extends keyof NotifyTarget['triggers']>(key: K, patch: Partial<NotifyTarget['triggers'][K]>): void =>
    set({ triggers: { ...tr, [key]: { ...tr[key], ...patch } } });
  const filt = (patch: Partial<NotifyTarget['filters']>): void => set({ filters: { ...f, ...patch } });

  // A test goes to the saved target — the server's copy, webhook and all — so
  // unsaved changes are saved first rather than the button sitting greyed out.
  const sendTest = async (): Promise<void> => {
    try {
      if (dirty) {
        setTest('Saving…');
        await save();
      }
      setTest('Sending…');
      setTest((await api.notifyTest(t.id)).message);
    } catch (err) {
      setTest((err as Error).message);
    }
  };

  return (
    <details className="notify__target" open={!t.webhookSet && !t.roomId}>
      <summary>
        <span className={`notify__dot ${status ? (status.ok ? 'is-ok' : 'is-bad') : ''}`} />
        <strong>{t.kind === 'discord' ? 'Discord' : 'Matrix'}</strong>
        {/* The name only when it says more than the kind already does. */}
        {t.name && !['discord', 'matrix', 'matrix room'].includes(t.name.trim().toLowerCase()) && <span>· {t.name}</span>}
        {!t.enabled && <span className="hint">(off)</span>}
        {status && (
          <span
            className={`hint notify__last${status.ok ? '' : ' is-bad'}`}
            title={`${status.message} — ${new Date(status.at).toLocaleString()}`}
          >
            {status.ok ? '' : '⚠ '}{status.message} · {new Date(status.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
      </summary>

      <div className="formrow">
        <label>Name</label>
        <input value={t.name} onChange={(e) => set({ name: e.target.value })} />
        <Check checked={t.enabled} onChange={(v) => set({ enabled: v })}>On</Check>
      </div>

      {t.kind === 'discord' ? (
        <>
          <Secret
            label="Webhook address"
            value={t.webhookUrl}
            isSet={Boolean(t.webhookSet)}
            placeholder="https://discord.com/api/webhooks/…"
            onChange={(v) => set({ webhookUrl: v })}
          />
          <div className="formrow">
            <label>Post as</label>
            <input value={t.username} placeholder="the webhook's own name" onChange={(e) => set({ username: e.target.value })} />
            <input value={t.avatarUrl} placeholder="avatar image address (optional)" onChange={(e) => set({ avatarUrl: e.target.value })} />
          </div>
          <div className="formrow">
            <label>Mention</label>
            <select
              value={['', '@here', '@everyone'].includes(t.mention) ? t.mention : 'role'}
              onChange={(e) => set({ mention: e.target.value === 'role' ? '' : e.target.value })}
            >
              <option value="">Nobody</option>
              <option value="@here">@here</option>
              <option value="@everyone">@everyone</option>
              <option value="role">A role…</option>
            </select>
            {!['@here', '@everyone'].includes(t.mention) && (
              <input value={t.mention} placeholder="role id (optional)" onChange={(e) => set({ mention: e.target.value.replace(/\D/g, '') })} />
            )}
          </div>
          <div className="formrow">
            <label>Look</label>
            <select value={t.style} onChange={(e) => set({ style: e.target.value as NotifyTarget['style'] })}>
              <option value="full">Full: blurb, details, large picture</option>
              <option value="compact">Compact: a line and a thumbnail</option>
            </select>
            <Check checked={t.showImage} onChange={(v) => set({ showImage: v })}>Pictures</Check>
          </div>
        </>
      ) : (
        <>
          <div className="formrow">
            <label>Room</label>
            <input
              list="matrix-rooms"
              value={t.roomId}
              placeholder="!abc123:example.org or #events:example.org"
              onChange={(e) => set({ roomId: e.target.value })}
            />
            {rooms.find((r) => r.roomId === t.roomId)?.name && (
              <span className="hint">{rooms.find((r) => r.roomId === t.roomId)!.name}</span>
            )}
          </div>
          <div className="formrow">
            <label>Bot’s name here</label>
            <input value={t.username} placeholder="its account’s own name" onChange={(e) => set({ username: e.target.value })} />
          </div>
          <div className="formrow">
            <label>Look</label>
            <select value={t.style} onChange={(e) => set({ style: e.target.value as NotifyTarget['style'] })}>
              <option value="full">Full: details, blurb and picture</option>
              <option value="compact">Compact: a line each</option>
            </select>
            <Check checked={t.showImage} onChange={(v) => set({ showImage: v })}>Pictures</Check>
          </div>
          <div className="formrow">
            <label>Mention</label>
            <select value={t.mention === '@room' ? '@room' : ''} onChange={(e) => set({ mention: e.target.value })}>
              <option value="">Nobody</option>
              <option value="@room">@room (the bot needs permission to)</option>
            </select>
            <Check checked={t.matrixLoud} onChange={(v) => set({ matrixLoud: v })}>
              Ordinary messages, which notify phones
            </Check>
          </div>
          <Check checked={t.commands} onChange={(v) => set({ commands: v })}>
            Answer commands here, listing only what the filters below let through
          </Check>
        </>
      )}

      <h4>When</h4>
      <div className="notify__grid">
        <Check checked={tr.newEvents.enabled} onChange={(v) => trig('newEvents', { enabled: v })}>New events found</Check>
        {tr.newEvents.enabled && (
          <span className="hint">
            after{' '}
            <input className="notify__num" type="number" min={0} max={1440} value={tr.newEvents.settleMinutes}
              onChange={(e) => trig('newEvents', { settleMinutes: Number(e.target.value) })} /> min to settle, up to{' '}
            <input className="notify__num" type="number" min={1} max={50} value={tr.newEvents.maxPerRun}
              onChange={(e) => trig('newEvents', { maxPerRun: Number(e.target.value) })} /> at a time
          </span>
        )}
        <Check checked={tr.digest.enabled} onChange={(v) => trig('digest', { enabled: v })}>Digest</Check>
        {tr.digest.enabled && (
          <span className="hint">
            <select value={tr.digest.cadence} onChange={(e) => trig('digest', { cadence: e.target.value as 'daily' | 'weekly' })}>
              <option value="daily">every day</option>
              <option value="weekly">every week on</option>
            </select>{' '}
            {tr.digest.cadence === 'weekly' && (
              <select value={tr.digest.weekday} onChange={(e) => trig('digest', { weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}{' '}
            at <input className="notify__num" type="number" min={0} max={23} value={tr.digest.hour}
              onChange={(e) => trig('digest', { hour: Number(e.target.value) })} />:00, the next{' '}
            <input className="notify__num" type="number" min={1} max={60} value={tr.digest.daysAhead}
              onChange={(e) => trig('digest', { daysAhead: Number(e.target.value) })} /> days
          </span>
        )}
        <Check checked={tr.reminders.enabled} onChange={(v) => trig('reminders', { enabled: v })}>Reminders before shortlisted events</Check>
        {tr.reminders.enabled && (
          <span className="hint">
            <input
              style={{ width: 120 }}
              defaultValue={csv(tr.reminders.hoursBefore)}
              onBlur={(e) => trig('reminders', { hoursBefore: fromCsv(e.target.value).map(Number).filter((n) => Number.isFinite(n) && n >= 0) })}
            /> hours before
          </span>
        )}
        <Check checked={tr.starredChanges.enabled} onChange={(v) => trig('starredChanges', { enabled: v })}>
          A shortlisted event’s time, place or name changing
        </Check>
      </div>

      <h4>Only events…</h4>
      <p className="hint">Leave a row empty to let everything through it.</p>
      <label className="hint">in these places</label>
      <Chips options={[...places, 'unknown']} picked={f.places} onChange={(v) => filt({ places: v })} />
      <label className="hint">in these categories</label>
      <Chips options={categories} picked={f.categories} onChange={(v) => filt({ categories: v })} />
      <label className="hint">never these categories</label>
      <Chips options={categories} picked={f.excludeCategories} onChange={(v) => filt({ excludeCategories: v })} off />
      <div className="formrow">
        <label>Mentioning any of</label>
        <input defaultValue={csv(f.keywords)} placeholder="drift, cars and coffee" onBlur={(e) => filt({ keywords: fromCsv(e.target.value) })} />
      </div>
      <div className="formrow">
        <label>But not</label>
        <input defaultValue={csv(f.excludeKeywords)} placeholder="kids, junior" onBlur={(e) => filt({ excludeKeywords: fromCsv(e.target.value) })} />
      </div>
      <div className="formrow">
        <label>Photo score at least</label>
        <input className="notify__num" type="number" min={0} max={100} value={f.minPhotoScore}
          onChange={(e) => filt({ minPhotoScore: Number(e.target.value) })} />
        <Check checked={f.starredOnly} onChange={(v) => filt({ starredOnly: v })}>Shortlisted only</Check>
      </div>

      <div className="formrow">
        <Check checked={t.quietHours.enabled} onChange={(v) => set({ quietHours: { ...t.quietHours, enabled: v } })}>Quiet hours</Check>
        {t.quietHours.enabled && (
          <span className="hint">
            from <input className="notify__num" type="number" min={0} max={23} value={t.quietHours.from}
              onChange={(e) => set({ quietHours: { ...t.quietHours, from: Number(e.target.value) } })} />:00 to{' '}
            <input className="notify__num" type="number" min={0} max={23} value={t.quietHours.to}
              onChange={(e) => set({ quietHours: { ...t.quietHours, to: Number(e.target.value) } })} />:00 — held, not dropped
          </span>
        )}
      </div>

      <div className="notify__actions">
        <button
          title={dirty ? 'Saves your changes, then sends a test to this target' : 'Sends the next few matching events to this target'}
          onClick={() => void sendTest()}
        >
          {dirty ? 'Save & send a test' : 'Send a test'}
        </button>
        {test && <span className="hint">{test}</span>}
        <button className="notify__remove" onClick={remove}>Remove target</button>
      </div>
    </details>
  );
}

export default function NotifyPanel({ draft, set, dirty, save }: {
  draft: SettingsType;
  set: (patch: Partial<SettingsType>) => void;
  dirty: boolean;
  /** The page's own Save, so a test can save first. */
  save: () => Promise<void>;
}) {
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    api.topics().then((r) => setCategories(r.categories ?? [])).catch(() => undefined);
    let alive = true;
    const tick = (): void => {
      api.notifyStatus().then((s) => alive && setStatus(s)).catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const targets = draft.notifyTargets ?? [];
  const bot = draft.matrixBot ?? { enabled: false, homeserver: '', commandPrefix: '!', allowedUsers: [], commandsEverywhere: true };
  const setBot = (patch: Partial<typeof bot>): void => set({ matrixBot: { ...bot, ...patch } });
  const places = [...new Set([draft.city, ...(draft.eventAreas ?? []).map((a) => a.name)].map((p) => town(p ?? '')).filter(Boolean))];
  const m = status?.matrix;

  return (
    <>
      <section>
        <h2>🔔 Notifications</h2>
        <p className="hint">
          Tell a Discord channel or a Matrix room about events. Each target has its own triggers and filters;
          checked every five minutes by the <em>Send notifications</em> task.
        </p>
        <div className="formrow">
          <label>This app’s address</label>
          <input value={draft.appUrl ?? ''} placeholder="https://events.example.com (optional)" onChange={(e) => set({ appUrl: e.target.value })} />
        </div>
        <p className="hint" style={{ marginTop: -4 }}>For an “Open in Event Scout” link in each message. Leave blank to link only to the listing.</p>

        {targets.map((t) => (
          <TargetCard
            key={t.id}
            target={t}
            places={places}
            categories={categories}
            status={status?.targets[t.id] ?? undefined}
            dirty={dirty}
            save={save}
            rooms={m?.joinedRooms ?? []}
            update={(next) => set({ notifyTargets: targets.map((x) => (x.id === t.id ? next : x)) })}
            remove={() => set({ notifyTargets: targets.filter((x) => x.id !== t.id) })}
          />
        ))}
        <div className="notify__actions">
          <button onClick={() => set({ notifyTargets: [...targets, blankTarget('discord')] })}>+ Discord webhook</button>
          <button onClick={() => set({ notifyTargets: [...targets, blankTarget('matrix')] })}>+ Matrix room</button>
        </div>
        <datalist id="matrix-rooms">
          {(m?.joinedRooms ?? []).map((r) => (
            <option key={r.roomId} value={r.roomId}>{r.name}</option>
          ))}
        </datalist>
      </section>

      <section>
        <h2>
          Matrix bot
          <label className="toggle" style={{ marginLeft: 'auto', fontWeight: 400 }}>
            <input type="checkbox" checked={bot.enabled} onChange={(e) => setBot({ enabled: e.target.checked })} /> Enabled
          </label>
        </h2>
        <p className="hint">
          One Matrix account posts to every Matrix room above and answers commands in them — <code>{bot.commandPrefix || '!'}help</code> lists
          them. Give it its own account, invite it from an allowed account, and use an unencrypted room: it cannot read encrypted ones.
        </p>
        {m && (
          <div className={`status-line ${m.state === 'running' ? 'ok' : m.state === 'error' ? 'error' : ''}`}>
            ● {m.state === 'running' ? `Connected as ${m.userId}, in ${m.rooms} room${m.rooms === 1 ? '' : 's'}` : m.state}
            {m.lastError && ` — ${m.lastError}`}
          </div>
        )}
        {(m?.ignoredInvites ?? []).map((i) => (
          <div key={i.roomId} className="status-line error">
            ⚠ Invited to {i.roomId} by {i.from}, who is not on the allowed list, so it did not join.{' '}
            {!bot.allowedUsers.includes(i.from) && (
              <button className="linky" onClick={() => setBot({ allowedUsers: [...bot.allowedUsers, i.from] })}>
                Allow {i.from}
              </button>
            )}{' '}
            Then save, and it joins.
          </div>
        ))}
        {bot.enabled && bot.allowedUsers.length === 0 && !(m?.ignoredInvites ?? []).length && (
          <p className="hint">
            No accounts are allowed yet, so it will not accept any invite. Add yours below.
          </p>
        )}
        {(m?.joinedRooms ?? []).length > 0 && (
          <div className="notify__rooms">
            <label className="hint">It is in</label>
            {m!.joinedRooms!.map((r) => {
              const has = targets.some((t) => t.kind === 'matrix' && t.roomId === r.roomId);
              return (
                <div key={r.roomId} className="formrow">
                  <span>{r.name || 'Unnamed room'}</span>
                  <code className="hint">{r.roomId}</code>
                  {has ? (
                    <span className="hint">set up above</span>
                  ) : (
                    <button
                      onClick={() =>
                        set({ notifyTargets: [...targets, { ...blankTarget('matrix'), name: r.name || 'Matrix room', roomId: r.roomId }] })
                      }
                    >
                      Set up notifications here
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <Check checked={bot.commandsEverywhere !== false} onChange={(v) => setBot({ commandsEverywhere: v })}>
          Answer commands in rooms with nothing set up above, listing everything
        </Check>
        <div className="formrow">
          <label>Homeserver</label>
          <input value={bot.homeserver} placeholder="https://matrix.example.org" onChange={(e) => setBot({ homeserver: e.target.value })} />
        </div>
        <Secret
          label="Access token"
          value={draft.matrixAccessToken}
          isSet={Boolean(draft.secretsSet?.matrixAccessToken)}
          placeholder="syt_…"
          onChange={(v) => set({ matrixAccessToken: v })}
        />
        <div className="formrow">
          <label>Command prefix</label>
          <input className="notify__num" value={bot.commandPrefix} onChange={(e) => setBot({ commandPrefix: e.target.value })} />
        </div>
        <div className="formrow">
          <label>Allowed accounts</label>
          <input
            // Keyed on the list, so "Allow" above shows up here at once.
            key={csv(bot.allowedUsers)}
            defaultValue={csv(bot.allowedUsers)}
            placeholder="@you:example.org"
            onBlur={(e) => setBot({ allowedUsers: fromCsv(e.target.value) })}
          />
        </div>
        <p className="hint" style={{ marginTop: -4 }}>
          May invite the bot and use <code>star</code>, <code>unstar</code> and <code>hide</code>. Anyone in the room may list and search.
        </p>
      </section>
    </>
  );
}
