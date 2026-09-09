/**
 * The background jobs this app runs, in one place.
 *
 * Before this they were four `cron.schedule` calls at the foot of index.ts with
 * their state scattered behind them: `refreshing` was a module global in
 * refresh.ts, density kept a running flag plus two kv keys of its own, and
 * archiving remembered nothing at all. There was no way to ask when something
 * last ran, no way to run one by hand except through whichever bespoke route
 * happened to exist, and no way to notice a job had been failing for a week.
 *
 * A task is a name, a schedule, a way to tell whether it is switched on, and
 * something to run. The registry adds the parts every one of them was writing
 * for itself: a lock, a bounded log, last-run and last-result in the kv table,
 * and a derived next-due.
 */

export interface TaskResult {
  ok: boolean;
  message: string;
}

export type TaskLog = (msg: string) => void;

/**
 * What a Run button can hand a task beyond "go".
 *
 * Only the Waze passes want anything: they can be asked to leave the window
 * open so the map can be driven by hand, and how long for is a decision made at
 * the moment somebody presses the button, not a setting.
 */
export interface TaskArg {
  holdSeconds?: number;
}

export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface TaskDef {
  name: string;
  label: string;
  description: string;
  /**
   * Cron expression the scheduler ticks on. Absent means the task only ever
   * runs when somebody asks for it.
   */
  schedule?: string;
  /**
   * Minutes that must have elapsed since the last run before a tick does
   * anything. The tick is deliberately more frequent than this: it is what
   * lets a changed interval take effect without a restart.
   */
  intervalMinutes?: () => number;
  enabled: () => boolean;
  /** Flip the setting behind `enabled`. Absent for tasks that cannot be switched off. */
  setEnabled?: (on: boolean) => void;
  /**
   * Tasks that must never run at the same time as one another, named by a
   * shared string. Defaults to the task name, meaning it excludes only itself.
   *
   * This is not decoration. Density sampling, venue discovery and both Waze
   * passes drive the same browser and the same profile directory, whose lock is
   * exclusive; they shared a single `running` flag before this, and losing that
   * would put two of them on one browser.
   */
  lockGroup?: string;
  run: (log: TaskLog, arg: TaskArg) => Promise<TaskResult>;
}

export interface TaskStatus {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  canDisable: boolean;
  manualOnly: boolean;
  running: boolean;
  /** The task holding this one's lock, when it is not this one. */
  blockedBy: string | null;
  schedule: string | null;
  intervalMinutes: number | null;
  lastRun: string | null;
  lastResult: string | null;
  lastOk: boolean | null;
  nextDue: string | null;
  log: string[];
}

/** Lines one task keeps. Enough to see what a pass did, bounded so it cannot grow. */
const MAX_LOG_LINES = 200;

/** When a task with an interval may next run. Null when it has never run. */
export function nextDueFrom(lastRun: string | null, intervalMinutes: number | null): string | null {
  if (!lastRun || intervalMinutes == null) return null;
  const at = Date.parse(lastRun);
  if (!Number.isFinite(at)) return null;
  return new Date(at + intervalMinutes * 60_000).toISOString();
}

/**
 * Whether enough time has passed for a scheduled tick to do anything.
 *
 * A task that has never run is always due, which is what makes a newly switched
 * on job start at the next tick rather than an interval later.
 */
export function isDue(lastRun: string | null, intervalMinutes: number | null, now = Date.now()): boolean {
  if (intervalMinutes == null) return true;
  if (!lastRun) return true;
  const at = Date.parse(lastRun);
  if (!Number.isFinite(at)) return true;
  return now - at >= intervalMinutes * 60_000;
}

export function createRegistry(store: KvStore) {
  const defs = new Map<string, TaskDef>();
  const logs = new Map<string, string[]>();
  /** Lock group to the task currently holding it. */
  const held = new Map<string, string>();

  const groupOf = (def: TaskDef): string => def.lockGroup ?? def.name;
  const key = (name: string, field: string): string => `task:${name}:${field}`;

  function record(name: string, result: TaskResult): void {
    store.set(key(name, 'lastRun'), new Date().toISOString());
    store.set(key(name, 'lastResult'), result.message);
    store.set(key(name, 'lastOk'), result.ok ? '1' : '0');
  }

  function register(def: TaskDef): void {
    defs.set(def.name, def);
  }

  function list(): TaskDef[] {
    return [...defs.values()];
  }

  function status(name: string): TaskStatus | null {
    const def = defs.get(name);
    if (!def) return null;
    const lastRun = store.get(key(name, 'lastRun'));
    const lastOk = store.get(key(name, 'lastOk'));
    const interval = def.intervalMinutes ? def.intervalMinutes() : null;
    const holder = held.get(groupOf(def)) ?? null;
    return {
      name: def.name,
      label: def.label,
      description: def.description,
      enabled: def.enabled(),
      canDisable: Boolean(def.setEnabled),
      manualOnly: !def.schedule,
      running: holder === name,
      blockedBy: holder && holder !== name ? (defs.get(holder)?.label ?? holder) : null,
      schedule: def.schedule ?? null,
      intervalMinutes: interval,
      lastRun,
      lastResult: store.get(key(name, 'lastResult')),
      lastOk: lastOk == null ? null : lastOk === '1',
      nextDue: def.schedule ? nextDueFrom(lastRun, interval) : null,
      log: logs.get(name) ?? [],
    };
  }

  function statuses(): TaskStatus[] {
    return list().map((d) => status(d.name)!);
  }

  function isRunning(name: string): boolean {
    const def = defs.get(name);
    return def ? held.get(groupOf(def)) === name : false;
  }

  /**
   * Run a task, unless it or something sharing its lock is already going.
   *
   * Refused rather than queued, which is what each of these did for itself
   * beforehand: for jobs where the next run supersedes the last, stacking them
   * up only builds a pile behind whatever is stuck.
   *
   * `force` is what a Run button means: go even though the schedule would not
   * have, and even though the task is switched off.
   */
  async function run(
    name: string,
    opts: { force?: boolean; arg?: TaskArg } = {}
  ): Promise<TaskResult> {
    const def = defs.get(name);
    if (!def) return { ok: false, message: `Unknown task: ${name}` };

    const group = groupOf(def);
    const holder = held.get(group);
    if (holder) {
      return {
        ok: false,
        message:
          holder === name
            ? `${def.label} is already running`
            : `${defs.get(holder)?.label ?? holder} is running and shares the same browser`,
      };
    }
    if (!opts.force && !def.enabled()) return { ok: false, message: `${def.label} is switched off` };

    held.set(group, name);
    const lines: string[] = [];
    const log: TaskLog = (msg) => {
      lines.push(msg);
      if (lines.length > MAX_LOG_LINES) lines.shift();
    };

    try {
      const result = await def.run(log, opts.arg ?? {});
      logs.set(name, lines);
      record(name, result);
      return result;
    } catch (err) {
      const message = (err as Error).message;
      logs.set(name, [...lines, `failed: ${message}`].slice(-MAX_LOG_LINES));
      record(name, { ok: false, message: `failed: ${message}` });
      return { ok: false, message };
    } finally {
      held.delete(group);
    }
  }

  /** A scheduler tick: run only if switched on and the interval has elapsed. */
  async function runIfDue(name: string): Promise<TaskResult | null> {
    const def = defs.get(name);
    if (!def || !def.enabled()) return null;
    if (held.has(groupOf(def))) return null;
    const interval = def.intervalMinutes ? def.intervalMinutes() : null;
    if (!isDue(store.get(key(name, 'lastRun')), interval)) return null;
    return run(name);
  }

  function setEnabled(name: string, on: boolean): TaskResult {
    const def = defs.get(name);
    if (!def) return { ok: false, message: `Unknown task: ${name}` };
    if (!def.setEnabled) return { ok: false, message: `${def.label} cannot be switched off` };
    def.setEnabled(on);
    return { ok: true, message: `${def.label} ${on ? 'enabled' : 'disabled'}` };
  }

  return { register, list, run, runIfDue, isRunning, status, statuses, setEnabled };
}

export type TaskRegistry = ReturnType<typeof createRegistry>;
