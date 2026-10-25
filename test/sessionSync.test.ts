import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuestSessionRecord, GuestSessionsSnapshot } from '@openchamber/sdk';
import { createTask, type TaskStatus } from '../src/domain/task.ts';
import { DEFAULT_SYNC_OPTIONS } from '../src/domain/sync.ts';
import { createSessionSync, type SessionSyncHost } from '../src/host/sessionSync.ts';
import { LIVE_SYNC_SUBSCRIPTION_LIMIT, liveSyncSubscriptionsActive, resetLiveSyncBudgetForTest } from '../src/host/subscriptionBudget.ts';


const session = (id: string, activity: GuestSessionRecord['activity'], outcome: GuestSessionRecord['outcome'] = null): GuestSessionRecord => ({
  id, title: id, projectId: 'p1', directory: '/x', parentId: null, createdAt: 1, updatedAt: 1, archivedAt: null, worktree: null, activity, outcome, items: [],
});

const snapshot = (projectId: string, sessions: GuestSessionRecord[], state: GuestSessionsSnapshot['state'] = 'ready'): GuestSessionsSnapshot => ({
  kind: 'sessions', projectId, state, coverage: [], sessions,
});

/** Records subscriptions and lets the test push snapshots and track unsubscribes. */
const fakeHost = () => {
  const listeners = new Map<string, (snapshot: GuestSessionsSnapshot) => void>();
  const unsubscribed: string[] = [];
  /** Fallback reads are served from here; reading a project with nothing staged fails. */
  const stagedReads = new Map<string, GuestSessionsSnapshot>();
  const host: SessionSyncHost = {
    onSessions: async (projectId, listener) => {
      listeners.set(projectId, listener);
      return () => { unsubscribed.push(projectId); listeners.delete(projectId); };
    },
    listSessions: async (projectId) => {
      const snap = stagedReads.get(projectId);
      if (!snap) throw new Error(`no read staged for ${projectId}`);
      return snap;
    },
  };
  return { host, push: (projectId: string, snap: GuestSessionsSnapshot) => listeners.get(projectId)?.(snap), listeners, unsubscribed, stagedReads };
};

test('a running session moves its linked task to in_progress', async () => {
  const { host, push } = fakeHost();
  const changes: Array<[string, string]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, (id, status) => changes.push([id, status]));
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot('p1', [session('ses_1', 'running')]));
  assert.deepEqual(changes, [[task.id, 'in_progress']]);
});

test('only one subscription per project even with several linked tasks', async () => {
  const { host, push } = fakeHost();
  const changes: Array<[string, string]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, (id, status) => changes.push([id, status]));
  const a = { ...createTask({ title: 'a', projectId: 'p1' }, 1), id: 't_a000001', sessionId: 'ses_a' };
  const b = { ...createTask({ title: 'b', projectId: 'p1' }, 2), id: 't_b000002', sessionId: 'ses_b' };
  sync.sync([a, b]);
  await Promise.resolve();
  push('p1', snapshot('p1', [session('ses_a', 'idle', 'completed'), session('ses_b', 'waiting-question')]));
  assert.deepEqual(new Set(changes.map(([id]) => id)), new Set([a.id, b.id]));
  assert.deepEqual(changes.find(([id]) => id === a.id), [a.id, 'review']);
  assert.deepEqual(changes.find(([id]) => id === b.id), [b.id, 'review']);
});

test('dropping the last task for a project releases its subscription', async () => {
  const { host, unsubscribed } = fakeHost();
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {});
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  sync.sync([]);
  await Promise.resolve();
  assert.deepEqual(unsubscribed, ['p1']);
});

test('a done task does not get moved even while its session keeps running', async () => {
  const { host, push } = fakeHost();
  const changes: unknown[] = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, (...args) => changes.push(args));
  const task = { ...createTask({ title: 't', projectId: 'p1', status: 'done' as const }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot('p1', [session('ses_1', 'running')]));
  assert.deepEqual(changes, []);
});

test('dispose releases every open subscription', async () => {
  const { host, unsubscribed } = fakeHost();
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {});
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  sync.dispose();
  await Promise.resolve();
  assert.deepEqual(unsubscribed, ['p1']);
});

test('an archived session reports gone, with no status change', async () => {
  const { host, push } = fakeHost();
  const changes: Array<[string, TaskStatus]> = [];
  const gone: Array<[string, string, string]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, (id, status) => changes.push([id, status]), (id, sessionId, reason) => gone.push([id, sessionId, reason]));
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot('p1', [{ ...session('ses_1', 'idle', 'completed'), archivedAt: 99 }]));
  assert.deepEqual(gone, [[task.id, 'ses_1', 'archived']]);
  assert.deepEqual(changes, []);
});

test('a session absent from a ready snapshot reports gone', async () => {
  const { host, push } = fakeHost();
  const gone: Array<[string, string, string]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {}, (id, sessionId, reason) => gone.push([id, sessionId, reason]));
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot('p1', []));
  assert.deepEqual(gone, [[task.id, 'ses_1', 'deleted']]);
});

test('a session absent from a loading snapshot reports nothing', async () => {
  const { host, push } = fakeHost();
  const gone: Array<[string, string, string]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {}, (id, sessionId, reason) => gone.push([id, sessionId, reason]));
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot('p1', [], 'loading'));
  assert.deepEqual(gone, []);
});

test('once the caller clears the link, the same absence reports nothing further', async () => {
  const { host, push } = fakeHost();
  const gone: Array<[string, string]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {}, (id, sessionId) => gone.push([id, sessionId]));
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot('p1', []));
  assert.equal(gone.length, 1);
  // What the board does in response: the task list with the link cleared.
  sync.sync([{ ...task, sessionId: null }]);
  push('p1', snapshot('p1', []));
  assert.equal(gone.length, 1);
});

test('absence is not trusted while the directory the session was last seen in is still loading', async () => {
  const { host, push } = fakeHost();
  const gone: Array<[string, string, string]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {}, (id, sessionId, reason) => gone.push([id, sessionId, reason]));
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);
  await Promise.resolve();
  // First a snapshot that shows the session, remembering its directory...
  push('p1', { kind: 'sessions', projectId: 'p1', state: 'ready', coverage: [{ directory: '/wt', state: 'ready' }], sessions: [{ ...session('ses_1', 'running'), directory: '/wt' }] });
  assert.deepEqual(gone, []);
  // ...then its directory flips to loading while the session is absent: not provably gone.
  push('p1', { kind: 'sessions', projectId: 'p1', state: 'ready', coverage: [{ directory: '/wt', state: 'loading' }], sessions: [] });
  assert.deepEqual(gone, []);
  // ...and once coverage is ready again, the absence is trusted.
  push('p1', { kind: 'sessions', projectId: 'p1', state: 'ready', coverage: [{ directory: '/wt', state: 'ready' }], sessions: [] });
  assert.deepEqual(gone, [[task.id, 'ses_1', 'deleted']]);
});

test('watches beyond the shared budget are refused and reported, and dispose returns every slot', async () => {
  resetLiveSyncBudgetForTest();
  const { host, listeners } = fakeHost();
  const errors: Array<[string, unknown]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {}, undefined, (projectId, error) => errors.push([projectId, error]));
  const tasks = Array.from({ length: LIVE_SYNC_SUBSCRIPTION_LIMIT + 2 }, (_, i) => ({
    ...createTask({ title: `t${i}`, projectId: `p${i}` }, i + 1),
    sessionId: `ses_${i}`,
  }));
  try {
    sync.sync(tasks);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(listeners.size, LIVE_SYNC_SUBSCRIPTION_LIMIT);
    assert.deepEqual(errors.map(([projectId]) => projectId), [`p${LIVE_SYNC_SUBSCRIPTION_LIMIT}`, `p${LIVE_SYNC_SUBSCRIPTION_LIMIT + 1}`]);
    assert.ok((errors[0]?.[1] as { code?: string } | undefined)?.code === 'SUBSCRIPTION_LIMIT');
    assert.equal(liveSyncSubscriptionsActive(), LIVE_SYNC_SUBSCRIPTION_LIMIT);
  } finally {
    sync.dispose();
  }
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(liveSyncSubscriptionsActive(), 0);
});

test('a refused registration returns its slot, so a later sync retries the watch', async () => {
  resetLiveSyncBudgetForTest();
  const listeners = new Map<string, (snapshot: GuestSessionsSnapshot) => void>();
  const rejected = new Set<string>();
  const stagedReads = new Map<string, GuestSessionsSnapshot>();
  const host: SessionSyncHost = {
    onSessions: async (projectId, listener) => {
      if (rejected.has(projectId)) throw new Error('refused');
      listeners.set(projectId, listener);
      return () => { listeners.delete(projectId); };
    },
    listSessions: async (projectId) => {
      const snap = stagedReads.get(projectId);
      if (!snap) throw new Error(`no read staged for ${projectId}`);
      return snap;
    },
  };
  const errors: unknown[] = [];
  const changes: Array<[string, string]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, (id, status) => changes.push([id, status]), undefined, (_projectId, error) => errors.push(error));
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  try {
    rejected.add('p1');
    sync.sync([task]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.equal(listeners.size, 0);
    assert.equal(liveSyncSubscriptionsActive(), 0);
    // The refused project is not left blind: fallback reads keep it syncing.
    stagedReads.set('p1', snapshot('p1', [session('ses_1', 'running')]));
    await sync.poll();
    assert.deepEqual(changes, [[task.id, 'in_progress']]);
    rejected.delete('p1');
    sync.sync([task]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(listeners.size, 1);
    assert.equal(liveSyncSubscriptionsActive(), 1);
  } finally {
    sync.dispose();
  }
  await Promise.resolve();
  assert.equal(liveSyncSubscriptionsActive(), 0);
});

test('a watch replaced while its registration is still pending ends the stale registration exactly once', async () => {
  resetLiveSyncBudgetForTest();
  const listeners = new Map<string, (snapshot: GuestSessionsSnapshot) => void>();
  const unsubscribed: string[] = [];
  const pending: Array<() => void> = [];
  const host: SessionSyncHost = {
    onSessions: (projectId, listener) => new Promise((resolve) => {
      pending.push(() => {
        listeners.set(projectId, listener);
        resolve(() => {
          unsubscribed.push(projectId);
          // A stale watch's unsubscribe must not tear down its replacement's listener.
          if (listeners.get(projectId) === listener) listeners.delete(projectId);
        });
      });

    }),
    listSessions: async (projectId) => ({ kind: 'sessions', projectId, state: 'ready', coverage: [], sessions: [] }) satisfies GuestSessionsSnapshot,
  };
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {});
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  sync.sync([task]);  // watch A: registration pending
  sync.sync([]);      // A dropped while pending
  sync.sync([task]);  // watch B takes its place
  assert.equal(pending.length, 2);
  // The dropped watch still holds its real slot: the host has not unsubscribed it yet.
  assert.equal(liveSyncSubscriptionsActive(), 2);
  pending[0]?.();     // A lands: no longer wanted — stopped right away
  pending[1]?.();     // B lands: current — stays
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(unsubscribed, ['p1']);
  assert.equal(listeners.size, 1);
  assert.equal(liveSyncSubscriptionsActive(), 1);
  sync.dispose();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(unsubscribed, ['p1', 'p1']);
  assert.equal(liveSyncSubscriptionsActive(), 0);
});

test('an over-budget project keeps syncing through fallback reads, then takes a freed slot in the same sync', async () => {
  resetLiveSyncBudgetForTest();
  const { host, push, listeners, stagedReads } = fakeHost();
  const changes: Array<[string, string]> = [];
  const errors: Array<[string, unknown]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, (id, status) => changes.push([id, status]), undefined, (projectId, error) => errors.push([projectId, error]));
  const liveTasks = Array.from({ length: LIVE_SYNC_SUBSCRIPTION_LIMIT }, (_, i) => ({
    ...createTask({ title: `t${i}`, projectId: `p${i}` }, i + 1),
    sessionId: `ses_${i}`,
  }));
  const overflow = { ...createTask({ title: 'over', projectId: 'p_over' }, 99), sessionId: 'ses_over' };
  try {
    sync.sync([...liveTasks, overflow]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(listeners.size, LIVE_SYNC_SUBSCRIPTION_LIMIT);
    assert.deepEqual(errors.map(([projectId]) => projectId), ['p_over']);
    // No live subscription for the over-budget project — fallback reads still drive updates.
    stagedReads.set('p_over', snapshot('p_over', [session('ses_over', 'running')]));
    await sync.poll();
    assert.deepEqual(changes, [[overflow.id, 'in_progress']]);
    // Dropping p0 frees its slot; the same sync puts the polled project on live.
    errors.length = 0;
    sync.sync([...liveTasks.slice(1), overflow]);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(!listeners.has('p0'));
    assert.ok(listeners.has('p_over'));
    assert.deepEqual(errors, []);
    push('p_over', snapshot('p_over', [session('ses_over', 'waiting-question')]));
    assert.deepEqual(changes[changes.length - 1], [overflow.id, 'review']);
  } finally {
    sync.dispose();
  }
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(liveSyncSubscriptionsActive(), 0);
});

test('a fallback tick that lands during a slow read is skipped, not overlapped', async () => {
  resetLiveSyncBudgetForTest();
  let reads = 0;
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const host: SessionSyncHost = {
    onSessions: async () => { throw new Error('refused'); },
    listSessions: async (projectId) => {
      reads += 1;
      await gate;
      return snapshot(projectId, []);
    },
  };
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {}, undefined, () => {});
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    sync.sync([task]);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(15_000); // first pass starts and blocks on the slow read
    mock.timers.tick(15_000); // this tick arrives mid-pass: it must not start another read
    assert.equal(reads, 1);
    openGate();
    await new Promise((resolve) => setImmediate(resolve)); // let the slow pass finish
    assert.equal(reads, 1);
    mock.timers.tick(15_000); // a tick after the pass completed reads again
    assert.equal(reads, 2);
  } finally {
    sync.dispose();
    mock.timers.reset();
  }
});

test('a failing fallback read is reported once per episode, and again only after it recovered', async () => {
  resetLiveSyncBudgetForTest();
  const stagedReads = new Map<string, GuestSessionsSnapshot>();
  const host: SessionSyncHost = {
    onSessions: async () => { throw new Error('refused'); },
    listSessions: async (projectId) => {
      const snap = stagedReads.get(projectId);
      if (!snap) throw new Error(`unreadable ${projectId}`);
      return snap;
    },
  };
  const errors: Array<[string, unknown]> = [];
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {}, undefined, (projectId, error) => errors.push([projectId, error]));
  const task = { ...createTask({ title: 't', projectId: 'p1' }, 1), sessionId: 'ses_1' };
  try {
    sync.sync([task]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(errors.length, 1); // the refused registration, reported by watch()
    await sync.poll(); // the fallback read fails too
    assert.equal(errors.length, 2);
    assert.equal(errors[1]?.[0], 'p1');
    assert.match(String(errors[1]?.[1]), /unreadable p1/); // the real error, not a generic one
    await sync.poll(); // same failure episode: no repeat
    assert.equal(errors.length, 2);
    stagedReads.set('p1', snapshot('p1', [])); // recovery
    await sync.poll();
    assert.equal(errors.length, 2); // recovery itself is silent
    stagedReads.delete('p1'); // failure anew
    await sync.poll();
    assert.equal(errors.length, 3);
  } finally {
    sync.dispose();
  }
});

test('the fallback timer stops once its last project is live again', async () => {
  resetLiveSyncBudgetForTest();
  const cleared: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const stubSetInterval = (() => 1) as unknown as typeof setInterval;
  const stubClearInterval = ((id: unknown) => { cleared.push(id); }) as unknown as typeof clearInterval;
  const { host } = fakeHost();
  const sync = createSessionSync(host, DEFAULT_SYNC_OPTIONS, () => {});
  const liveTasks = Array.from({ length: LIVE_SYNC_SUBSCRIPTION_LIMIT }, (_, i) => ({
    ...createTask({ title: `t${i}`, projectId: `p${i}` }, i + 1),
    sessionId: `ses_${i}`,
  }));
  const overflow = { ...createTask({ title: 'over', projectId: 'p_over' }, 99), sessionId: 'ses_over' };
  try {
    globalThis.setInterval = stubSetInterval;
    globalThis.clearInterval = stubClearInterval;
    sync.sync([...liveTasks, overflow]);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(cleared, []); // the polled project keeps the timer alive
    // Dropping one live project lets the polled project take the freed slot.
    sync.sync([...liveTasks.slice(1), overflow]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(cleared.length, 1); // nothing polls anymore, so the timer is gone
  } finally {
    sync.dispose();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});
