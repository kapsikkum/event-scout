import { useEffect, useState, type ReactNode } from 'react';
import { api, LlmStatus, NotifyStatus, NotifyTarget, Settings as SettingsType } from '../api';

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
    matrixLoud: true,
    commands: true,
    matrixLook: 'minimal',
    triggers: {
      newEvents: { enabled: true, settleMinutes: 30, maxPerRun: 10 },
      digest: { enabled: false, cadence: 'weekly', weekday: 4, hour: 18, daysAhead: 7 },
      reminders: { enabled: false, hoursBefore: [24, 2] },
      starredChanges: { enabled: false },
      busy: { enabled: false, threshold: 80, venues: [], cooldownHours: 6 },
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

function TargetCard({ target, update, remove, places, categories, status, dirty, save, rooms, venues }: {
  rooms: { roomId: string; name: string }[];
  /** Every place venue density samples, for the busy-place trigger. */
  venues: string[];
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
  const sendTest = async (what: 'test' | 'looks' = 'test'): Promise<void> => {
    try {
      if (dirty) {
        setTest('Saving…');
        await save();
      }
      setTest('Sending…');
      setTest((await (what === 'looks' ? api.notifyLooks(t.id) : api.notifyTest(t.id))).message);
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
            <select value={t.matrixLook} onChange={(e) => set({ matrixLook: e.target.value as NotifyTarget['matrixLook'] })}>
              <option value="minimal">Minimal: a bold title and a line of facts each</option>
              <option value="cards">Cards: a message each, with the blurb</option>
              <option value="table">Table: a row each (best on desktop)</option>
              <option value="plain">Plain text: no formatting at all</option>
            </select>
            {(t.matrixLook === 'minimal' || t.matrixLook === 'cards') && (
              <Check checked={t.showImage} onChange={(v) => set({ showImage: v })}>Flyers</Check>
            )}
          </div>
          <div className="formrow">
            <label>Mention</label>
            <select value={t.mention === '@room' ? '@room' : ''} onChange={(e) => set({ mention: e.target.value })}>
              <option value="">Nobody</option>
              <option value="@room">@room (the bot needs permission to)</option>
            </select>
            <Check checked={!t.matrixLoud} onChange={(v) => set({ matrixLoud: !v })}>
              Quiet notices: greyed out, no alert
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
        <Check checked={tr.busy?.enabled ?? false} onChange={(v) => trig('busy', { enabled: v })}>A place getting busy</Check>
        {tr.busy?.enabled && (
          <span className="hint">
            at{' '}
            <input className="notify__num" type="number" min={10} max={100} value={tr.busy.threshold}
              onChange={(e) => trig('busy', { threshold: Number(e.target.value) })} />% or more of its busiest, then not again for{' '}
            <input className="notify__num" type="number" min={1} max={72} value={tr.busy.cooldownHours}
              onChange={(e) => trig('busy', { cooldownHours: Number(e.target.value) })} /> h
          </span>
        )}
      </div>
      {tr.busy?.enabled && (
        <>
          <label className="hint">only these places — none picked means all of them</label>
          {venues.length ? (
            <Chips options={venues} picked={tr.busy.venues} onChange={(v) => trig('busy', { venues: v })} />
          ) : (
            <p className="hint">No places sampled yet: switch on Venue density under Density and let it run once.</p>
          )}
        </>
      )}

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
        {t.kind === 'matrix' && (
          <button title="Posts one sample of each look to this room, to compare in your own client" onClick={() => void sendTest('looks')}>
            {dirty ? 'Save & compare looks' : 'Compare looks'}
          </button>
        )}
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
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [venueNames, setVenueNames] = useState<string[]>([]);

  useEffect(() => {
    api.topics().then((r) => setCategories(r.categories ?? [])).catch(() => undefined);
    api.llmStatus().then(setLlm).catch(() => setLlm(null));
    // Every place density samples, across its areas, for the busy-place trigger.
    api
      .densityAreas()
      .then(async ({ areas }) => {
        const lists = await Promise.all(areas.map((a) => api.venues(a.slug).catch(() => [])));
        setVenueNames([...new Set(lists.flat().map((v) => v.name))].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => undefined);
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
  const bot = draft.matrixBot ?? {
    enabled: false, homeserver: '', commandPrefix: '!', allowedUsers: [], commandsEverywhere: true,
    chat: { enabled: false, eventContext: true, model: '', systemPrompt: '', historyMessages: 12 },
  };
  const chat = bot.chat ?? { enabled: false, eventContext: true, model: '', systemPrompt: '', historyMessages: 12 };
  const setChat = (patch: Partial<typeof chat>): void => setBot({ chat: { ...chat, ...patch } });
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
            venues={venueNames}
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
          May invite the bot into rooms. The bot only reads: anyone in a room it is in can list and search, and
          nothing is changed from Matrix.
        </p>

        {/* How it is getting on, after the fields that decide it. */}
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
          <div className="status-line">No accounts are allowed yet, so it will not accept any invite. Add yours above.</div>
        )}

        {(m?.joinedRooms ?? []).length > 0 && (
          <div className="notify__rooms">
            <h4>Rooms it is in</h4>
            {m!.joinedRooms!.map((r) => {
              const has = targets.some((t) => t.kind === 'matrix' && t.roomId === r.roomId);
              return (
                <div key={r.roomId} className="notify__room">
                  <span className="notify__room-name">{r.name || 'Unnamed room'}</span>
                  <code className="notify__room-id" title={r.roomId}>{r.roomId}</code>
                  {has ? (
                    <span className="notify__room-state">✓ Set up above</span>
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

        <h4 className="notify__sub">Chat</h4>
        <p className="hint">
          With chat on, say <code>{bot.commandPrefix || '!'}chat start</code> in a room (allowed accounts only) and the local model
          answers every message there that is not a command, until <code>{bot.commandPrefix || '!'}chat end</code> or
          an hour of quiet. It sees the upcoming events (that room’s filters apply, if it has a target), today’s
          weather and light, which places are busy, and the last few messages. It can only read.
        </p>
        {llm && !llm.reachable ? (
          <div className="status-line error">No Ollama reachable{llm.problem ? ` — ${llm.problem}` : ''}. Set it up under Local model.</div>
        ) : (
          <>
            <Check checked={chat.enabled} onChange={(v) => setChat({ enabled: v })}>
              Chat on — switching it off silences every room at once
            </Check>
            <Check checked={chat.eventContext !== false} onChange={(v) => setChat({ eventContext: v })}>
              Give it the events, weather and busy places — off, it is the bare model with only the system prompt
            </Check>
            <div className="formrow">
              <label>Model</label>
              <select value={chat.model} onChange={(e) => setChat({ model: e.target.value })}>
                <option value="">{draft.llmModel ? `Same as the listing pass (${draft.llmModel})` : 'Choose a model…'}</option>
                {(llm?.models ?? []).map((mdl) => (
                  <option key={mdl.name} value={mdl.name}>
                    {mdl.name} ({Math.round(mdl.size / 1e9)} GB)
                  </option>
                ))}
              </select>
            </div>
            <div className="formrow notify__prompt">
              <label>System prompt</label>
              <textarea
                rows={5}
                value={chat.systemPrompt}
                placeholder="Blank for the built-in one: a friendly assistant that talks only about the listed events, names their date and place, and keeps answers short."
                onChange={(e) => setChat({ systemPrompt: e.target.value })}
              />
            </div>
            <p className="hint" style={{ marginTop: -4 }}>
              With the events on, the date, your areas, the weather and the event list are added after it, whatever
              it says. In a room, <code>{bot.commandPrefix || '!'}chat system</code>, <code>context</code> and{' '}
              <code>model</code> change these for that chat only.
            </p>
            <div className="formrow">
              <label>Remembers</label>
              <input
                className="notify__num"
                type="number"
                min={0}
                max={40}
                value={chat.historyMessages}
                onChange={(e) => setChat({ historyMessages: Number(e.target.value) })}
              />
              <span className="hint">earlier messages per room</span>
            </div>
          </>
        )}
      </section>
    </>
  );
}
