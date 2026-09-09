import { useCallback, useEffect, useRef, useState } from 'react';
import { api, TaskStatus } from '../api';

/**
 * Every background job, with what it did last and a way to run it now.
 *
 * These jobs used to be invisible: the only sign that one had been failing for
 * a week was events quietly going stale. A job that has never run, is switched
 * off, or is waiting on the browser another job is holding all read differently
 * here, because they need different things done about them.
 */

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - Date.parse(iso);
  const ahead = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  const say = (text: string): string => (ahead ? `in ${text}` : `${text} ago`);
  if (mins < 1) return ahead ? 'any moment' : 'just now';
  if (mins < 60) return say(`${mins}m`);
  const hours = Math.round(mins / 60);
  if (hours < 24) return say(`${hours}h`);
  return say(`${Math.round(hours / 24)}d`);
}

function every(task: TaskStatus): string {
  if (task.manualOnly) return 'when asked';
  const mins = task.intervalMinutes;
  if (mins == null) return 'on a schedule';
  if (mins < 60) return `every ${mins} min`;
  if (mins % 60 === 0 && mins < 1440) return `every ${mins / 60}h`;
  return `every ${Math.round((mins / 60) * 10) / 10}h`;
}

/** The dot beside a task name: what state it is actually in, at a glance. */
function State({ task }: { task: TaskStatus }) {
  if (task.running) return <span style={{ color: 'var(--accent)' }}>running</span>;
  if (task.blockedBy) return <span style={{ color: 'var(--muted)' }}>waiting on {task.blockedBy}</span>;
  if (!task.enabled) return <span style={{ color: 'var(--muted)' }}>off</span>;
  if (task.lastOk === false) return <span style={{ color: 'var(--red)' }}>failed</span>;
  if (task.lastOk === true) return <span style={{ color: 'var(--green)' }}>ok</span>;
  return <span style={{ color: 'var(--muted)' }}>not run yet</span>;
}

export default function Tasks() {
  const [tasks, setTasks] = useState<TaskStatus[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');
  const inFlight = useRef(false);

  // One request at a time, for the same reason the status poll does it: the
  // server is single-threaded, and a long task makes every poll behind it queue.
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setTasks((await api.tasks()).tasks);
    } catch {
      /* leave the last good list on screen */
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(id);
  }, [load]);

  async function run(task: TaskStatus): Promise<void> {
    setBusy(task.name);
    setMessage(`${task.label}: starting…`);
    try {
      const result = await api.runTask(task.name);
      setMessage(`${task.label}: ${result.message}`);
    } catch (err) {
      setMessage(`${task.label}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
      void load();
    }
  }

  async function toggle(task: TaskStatus): Promise<void> {
    // Painted immediately: the poll is three seconds away and a checkbox that
    // does not move when clicked reads as broken.
    setTasks((prev) =>
      prev ? prev.map((t) => (t.name === task.name ? { ...t, enabled: !t.enabled } : t)) : prev
    );
    try {
      await api.enableTask(task.name, !task.enabled);
    } finally {
      void load();
    }
  }

  if (!tasks) return <p>Loading…</p>;

  return (
    <>
      <p className="hint" style={{ margin: '0 0 14px' }}>
        The jobs that run in the background. Each one refuses to start a second
        copy of itself, and the four that drive a browser take it in turns.
      </p>

      {message && (
        <p className="hint" style={{ color: 'var(--text)' }}>
          {message}
        </p>
      )}

      {tasks.map((task) => (
        <section key={task.name}>
            <div className="taskrow">
              <strong style={{ fontSize: 15.5 }}>{task.label}</strong>
              <State task={task} />
              <span className="hint" style={{ margin: 0 }}>
                {every(task)}
              </span>
              <div className="taskrow__actions">
                {task.canDisable && (
                  <label className="toggle" style={{ fontWeight: 400 }}>
                    <input type="checkbox" checked={task.enabled} onChange={() => void toggle(task)} /> enabled
                  </label>
                )}
                <button
                  onClick={() => void run(task)}
                  disabled={busy === task.name || task.running || Boolean(task.blockedBy)}
                >
                  {task.running ? 'Running…' : 'Run now'}
                </button>
              </div>
            </div>

            <p className="hint" style={{ marginBottom: 6 }}>
              {task.description}
            </p>

            <div className="hint taskmeta">
              <span>Last run {relative(task.lastRun)}</span>
              {/* A next-due already in the past means the tick has not come
                  round yet, not that something is wrong — say "due" rather than
                  a length of time ago, which reads as a date going backwards. */}
              {!task.manualOnly && task.enabled && !task.running && (
                <span>
                  {task.nextDue && Date.parse(task.nextDue) <= Date.now()
                    ? 'Due now'
                    : `Next ${relative(task.nextDue)}`}
                </span>
              )}
              {task.lastResult && (
                <span style={{ color: task.lastOk === false ? 'var(--red)' : 'var(--muted)' }}>
                  {task.lastResult}
                </span>
              )}
              {task.log.length > 0 && (
                <button onClick={() => setOpen(open === task.name ? null : task.name)}>
                  {open === task.name ? 'hide log' : `log (${task.log.length})`}
                </button>
              )}
            </div>

            {open === task.name && (
              <div className="activity__feed" style={{ maxHeight: 220, marginTop: 8 }}>
                {task.log.map((line, i) => (
                  <div key={i} className="activity__line">
                    {line}
                  </div>
                ))}
              </div>
            )}
        </section>
      ))}
    </>
  );
}
