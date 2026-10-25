import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuestWorktreesSnapshot } from '@openchamber/sdk';
import { createTask } from '../src/domain/task.ts';
import { createWorktreeSync, type WorktreeSyncHost } from '../src/host/worktreeSync.ts';
import { LIVE_SYNC_SUBSCRIPTION_LIMIT, liveSyncSubscriptionsActive, resetLiveSyncBudgetForTest } from '../src/host/subscriptionBudget.ts';


const worktree = (directory: string, status: GuestWorktreesSnapshot['worktrees'][number]['status'] = 'ready') => ({ directory, name: directory, branch: 'b', status });

const snapshot = (worktrees: GuestWorktreesSnapshot['worktrees'], state: GuestWorktreesSnapshot['state'] = 'ready'): GuestWorktreesSnapshot => ({
  kind: 'worktrees', projectId: 'p1', state, worktrees,
});

/** Records subscriptions and lets the test push snapshots and track unsubscribes. */
const fakeHost = () => {
  const listeners = new Map<string, (snapshot: GuestWorktreesSnapshot) => void>();
  const unsubscribed: string[] = [];
  /** Fallback reads are served from here; reading a project with nothing staged fails. */
  const stagedReads = new Map<string, GuestWorktreesSnapshot>();
  const host: WorktreeSyncHost = {
    onWorktrees: async (projectId, listener) => {
      listeners.set(projectId, listener);
      return () => { unsubscribed.push(projectId); listeners.delete(projectId); };
    },
    listWorktrees: async (projectId) => {
      const snap = stagedReads.get(projectId);
      if (!snap) throw new Error(`no read staged for ${projectId}`);
      return snap;
    },
  };
  return { host, push: (projectId: string, snap: GuestWorktreesSnapshot) => listeners.get(projectId)?.(snap), listeners, unsubscribed, stagedReads };

};

const linkedTask = () => ({ ...createTask({ title: 't', projectId: 'p1' }, 1), worktree: { directory: '/wt', branch: 'fix/x' } as const });

test('a deleted worktree reports its task gone', async () => {
  const { host, push } = fakeHost();
  const gone: string[] = [];
  const sync = createWorktreeSync(host, (taskId) => gone.push(taskId));
  const task = linkedTask();
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot([]));
  assert.deepEqual(gone, [task.id]);
});

test('a worktree reported missing is gone; one still creating or invalid is not', async () => {
  const { host, push } = fakeHost();
  const gone: string[] = [];
  const sync = createWorktreeSync(host, (taskId) => gone.push(taskId));
  const task = linkedTask();
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot([worktree('/wt', 'missing')]));
  assert.deepEqual(gone, [task.id]);
});

test('a loading snapshot reports nothing', async () => {
  const { host, push } = fakeHost();
  const gone: string[] = [];
  const sync = createWorktreeSync(host, (taskId) => gone.push(taskId));
  const task = linkedTask();
  sync.sync([task]);
  await Promise.resolve();
  push('p1', snapshot([], 'loading'));
  assert.deepEqual(gone, []);
});

test('a ready snapshot with the worktree present reports nothing', async () => {
  const { host, push } = fakeHost();
  const gone: string[] = [];
  const sync = createWorktreeSync(host, (taskId) => gone.push(taskId));
  sync.sync([linkedTask()]);
  await Promise.resolve();
  push('p1', snapshot([worktree('/wt')]));
  assert.deepEqual(gone, []);
});

test('dropping the last worktree-linked task releases its subscription, and dispose releases the rest', async () => {
  const { host, push, unsubscribed } = fakeHost();
  const sync = createWorktreeSync(host, () => {});
  const task = linkedTask();
  sync.sync([task]);
  await Promise.resolve();
  // Tasks without a worktree don't need a subscription.
  sync.sync([{ ...task, worktree: null }]);
  await Promise.resolve();
  assert.deepEqual(unsubscribed, ['p1']);
  sync.sync([task]);
  await Promise.resolve();
  sync.dispose();
  await Promise.resolve();
  assert.deepEqual(unsubscribed, ['p1', 'p1']);
});

test('watches beyond the shared budget are refused and reported, not silently dropped', async () => {
  resetLiveSyncBudgetForTest();
  const { host, listeners } = fakeHost();
  const errors: Array<[string, unknown]> = [];
  const sync = createWorktreeSync(host, () => {}, (projectId, error) => errors.push([projectId, error]));
  const tasks = Array.from({ length: LIVE_SYNC_SUBSCRIPTION_LIMIT + 1 }, (_, i) => ({
    ...createTask({ title: `t${i}`, projectId: `p${i}` }, i + 1),
    worktree: { directory: `/wt${i}`, branch: 'fix/x' } as const,
  }));
  try {
    sync.sync(tasks);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(listeners.size, LIVE_SYNC_SUBSCRIPTION_LIMIT);
    assert.deepEqual(errors.map(([projectId]) => projectId), [`p${LIVE_SYNC_SUBSCRIPTION_LIMIT}`]);
    assert.ok((errors[0]?.[1] as { code?: string } | undefined)?.code === 'SUBSCRIPTION_LIMIT');
    assert.equal(liveSyncSubscriptionsActive(), LIVE_SYNC_SUBSCRIPTION_LIMIT);
  } finally {
    sync.dispose();
  }
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(liveSyncSubscriptionsActive(), 0);
});

test('an over-budget project still reports a gone worktree through fallback reads', async () => {
  resetLiveSyncBudgetForTest();
  const { host, listeners, stagedReads } = fakeHost();
  const errors: Array<[string, unknown]> = [];
  const gone: string[] = [];
  const sync = createWorktreeSync(host, (taskId) => gone.push(taskId), (projectId, error) => errors.push([projectId, error]));
  const tasks = Array.from({ length: LIVE_SYNC_SUBSCRIPTION_LIMIT }, (_, i) => ({
    ...createTask({ title: `t${i}`, projectId: `p${i}` }, i + 1),
    worktree: { directory: `/wt${i}`, branch: 'fix/x' } as const,
  }));
  const overflow = { ...createTask({ title: 'over', projectId: 'p_over' }, 99), worktree: { directory: '/wt_over', branch: 'fix/x' } as const };
  try {
    sync.sync([...tasks, overflow]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(listeners.size, LIVE_SYNC_SUBSCRIPTION_LIMIT);
    assert.deepEqual(errors.map(([projectId]) => projectId), ['p_over']);
    // No live subscription for the over-budget project — the fallback read still catches the loss.
    stagedReads.set('p_over', { kind: 'worktrees', projectId: 'p_over', state: 'ready', worktrees: [] });
    await sync.poll();
    assert.deepEqual(gone, [overflow.id]);
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
  const host: WorktreeSyncHost = {
    onWorktrees: async () => { throw new Error('refused'); },
    listWorktrees: async (projectId) => {
      reads += 1;
      await gate;
      return { kind: 'worktrees', projectId, state: 'ready', worktrees: [] } satisfies GuestWorktreesSnapshot;
    },
  };
  const sync = createWorktreeSync(host, () => {}, () => {});
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    sync.sync([linkedTask()]);
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
  const stagedReads = new Map<string, GuestWorktreesSnapshot>();
  const host: WorktreeSyncHost = {
    onWorktrees: async () => { throw new Error('refused'); },
    listWorktrees: async (projectId) => {
      const snap = stagedReads.get(projectId);
      if (!snap) throw new Error(`unreadable ${projectId}`);
      return snap;
    },
  };
  const errors: Array<[string, unknown]> = [];
  const sync = createWorktreeSync(host, () => {}, (projectId, error) => errors.push([projectId, error]));
  const task = linkedTask();
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
    stagedReads.set('p1', snapshot([worktree('/wt')])); // recovery
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
  const sync = createWorktreeSync(host, () => {});
  const liveTasks = Array.from({ length: LIVE_SYNC_SUBSCRIPTION_LIMIT }, (_, i) => ({
    ...createTask({ title: `t${i}`, projectId: `p${i}` }, i + 1),
    worktree: { directory: `/wt${i}`, branch: 'fix/x' } as const,
  }));
  const overflow = { ...createTask({ title: 'over', projectId: 'p_over' }, 99), worktree: { directory: '/wt_over', branch: 'fix/x' } as const };
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
