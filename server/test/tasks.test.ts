import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRegistry, isDue, nextDueFrom, TaskResult } from '../src/tasks/registry.js';

/** A kv store in memory, so none of this touches the database. */
function store(): { get(k: string): string | null; set(k: string, v: string): void; map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

/** A promise plus the handle to settle it, for holding a task open mid-run. */
function deferred(): { promise: Promise<TaskResult>; resolve: (r: TaskResult) => void } {
  let resolve!: (r: TaskResult) => void;
  const promise = new Promise<TaskResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const OK = { ok: true, message: 'done' };

test('next due is the last run plus the interval, and unknown until it has run once', () => {
  assert.equal(nextDueFrom(null, 60), null);
  assert.equal(nextDueFrom('2026-09-09T10:00:00.000Z', null), null);
  assert.equal(nextDueFrom('2026-09-09T10:00:00.000Z', 45), '2026-09-09T10:45:00.000Z');
  // A last-run that cannot be parsed is not a date to count from.
  assert.equal(nextDueFrom('never', 45), null);
});

test('a task that has never run is due immediately', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');
  assert.equal(isDue(null, 60, now), true);
  assert.equal(isDue('2026-09-09T11:59:00.000Z', 60, now), false);
  assert.equal(isDue('2026-09-09T11:00:00.000Z', 60, now), true);
  // No interval means every tick counts.
  assert.equal(isDue('2026-09-09T11:59:59.000Z', null, now), true);
});

test('a run records when it happened and what it said', async () => {
  const kv = store();
  const tasks = createRegistry(kv);
  tasks.register({
    name: 'a', label: 'A', description: '', enabled: () => true,
    run: async (log) => {
      log('did a thing');
      return { ok: true, message: '3 kept' };
    },
  });

  const result = await tasks.run('a');
  assert.deepEqual(result, { ok: true, message: '3 kept' });

  const status = tasks.status('a')!;
  assert.equal(status.lastResult, '3 kept');
  assert.equal(status.lastOk, true);
  assert.ok(status.lastRun);
  assert.deepEqual(status.log, ['did a thing']);
});

test('a task that throws is recorded as failed rather than escaping', async () => {
  const tasks = createRegistry(store());
  tasks.register({
    name: 'boom', label: 'Boom', description: '', enabled: () => true,
    run: async () => {
      throw new Error('the browser went away');
    },
  });

  const result = await tasks.run('boom');
  assert.equal(result.ok, false);
  assert.equal(result.message, 'the browser went away');

  const status = tasks.status('boom')!;
  assert.equal(status.lastOk, false);
  assert.match(status.lastResult!, /the browser went away/);
  // The lock has to come back even when the run blew up, or nothing runs again.
  assert.equal(status.running, false);
  assert.equal((await tasks.run('boom')).message, 'the browser went away');
});

test('a second run is refused while the first is still going', async () => {
  const tasks = createRegistry(store());
  const gate = deferred();
  tasks.register({
    name: 'slow', label: 'Slow one', description: '', enabled: () => true,
    run: () => gate.promise,
  });

  const first = tasks.run('slow');
  assert.equal(tasks.isRunning('slow'), true);

  const second = await tasks.run('slow');
  assert.equal(second.ok, false);
  assert.match(second.message, /already running/);

  gate.resolve(OK);
  assert.deepEqual(await first, OK);
  assert.equal(tasks.isRunning('slow'), false);
});

/**
 * The one that matters. Density sampling, venue discovery and both Waze passes
 * drive the same browser and the same profile directory, whose lock is
 * exclusive. They shared a single module-level flag before the registry
 * existed, and a per-task lock would quietly let two of them start at once.
 */
test('tasks sharing a lock group cannot run at the same time', async () => {
  const tasks = createRegistry(store());
  const gate = deferred();
  for (const name of ['density', 'discover', 'waze']) {
    tasks.register({
      name, label: name, description: '', enabled: () => true, lockGroup: 'browser',
      run: name === 'density' ? () => gate.promise : async () => OK,
    });
  }
  // Something on its own lock, to show the exclusion is not global.
  tasks.register({ name: 'events', label: 'Events', description: '', enabled: () => true, run: async () => OK });

  const running = tasks.run('density');

  for (const blocked of ['discover', 'waze']) {
    const result = await tasks.run(blocked);
    assert.equal(result.ok, false, `${blocked} should have been refused`);
    assert.match(result.message, /shares the same browser/);
    assert.equal(tasks.status(blocked)!.blockedBy, 'density');
  }
  assert.deepEqual(await tasks.run('events'), OK);

  gate.resolve(OK);
  await running;
  // With the browser free again, the others go.
  assert.deepEqual(await tasks.run('waze'), OK);
});

test('a switched-off task runs when asked by hand but not on a tick', async () => {
  const kv = store();
  const tasks = createRegistry(kv);
  let on = false;
  let runs = 0;
  tasks.register({
    name: 'off', label: 'Off', description: '',
    schedule: '*/5 * * * *', intervalMinutes: () => 60,
    enabled: () => on,
    setEnabled: (next) => void (on = next),
    run: async () => {
      runs++;
      return OK;
    },
  });

  assert.equal(await tasks.runIfDue('off'), null);
  assert.equal(runs, 0);

  const forced = await tasks.run('off', { force: true });
  assert.equal(forced.ok, true);
  assert.equal(runs, 1);

  // Without force it is still refused, and says so rather than pretending.
  const refused = await tasks.run('off');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /switched off/);

  tasks.setEnabled('off', true);
  // Just ran, so the interval has not elapsed even though it is now on.
  assert.equal(await tasks.runIfDue('off'), null);
  assert.equal(runs, 1);

  kv.set('task:off:lastRun', new Date(Date.now() - 2 * 3600_000).toISOString());
  assert.deepEqual(await tasks.runIfDue('off'), OK);
  assert.equal(runs, 2);
});

test('a task with no setting behind it cannot be switched off', () => {
  const tasks = createRegistry(store());
  tasks.register({ name: 'always', label: 'Always', description: '', enabled: () => true, run: async () => OK });
  const result = tasks.setEnabled('always', false);
  assert.equal(result.ok, false);
  assert.equal(tasks.status('always')!.canDisable, false);
  assert.equal(tasks.setEnabled('nope', true).ok, false);
});

test('manual-only tasks advertise no schedule and no next due', async () => {
  const tasks = createRegistry(store());
  tasks.register({ name: 'byhand', label: 'By hand', description: '', enabled: () => true, run: async () => OK });
  await tasks.run('byhand');
  const status = tasks.status('byhand')!;
  assert.equal(status.manualOnly, true);
  assert.equal(status.schedule, null);
  assert.equal(status.nextDue, null);
});
