import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuestProjectsSnapshot, GuestSessionRecord, GuestSessionsSnapshot } from '@openchamber/sdk';
import { watchOrphanSessions, type OrphanSessionsHost } from '../src/host/orphanSessions.ts';

const session = (id: string, overrides: Partial<GuestSessionRecord> = {}): GuestSessionRecord => ({
  id, title: id, projectId: 'p1', directory: '/x', parentId: null, createdAt: 1000, updatedAt: 1000, archivedAt: null, worktree: null, activity: 'running', outcome: null, items: [],
  ...overrides,
});

/**
 * The sweep model's host: one onProjects registration plus one-off
 * listSessions reads whose content the test controls per project.
 */
const fakeHost = (sessionsByProject: () => Map<string, GuestSessionRecord[]>) => {
  const projectListeners: Array<(snapshot: GuestProjectsSnapshot) => void> = [];
  const projectUnsubscribed: boolean[] = [];
  const readCalls: string[] = [];
  const host: OrphanSessionsHost = {
    onProjects: async (listener) => {
      projectListeners.push(listener);
      return () => { projectUnsubscribed.push(true); projectListeners.splice(projectListeners.indexOf(listener), 1); };
    },
    listSessions: async (projectId: string) => {
      readCalls.push(projectId);
      return { kind: 'sessions', projectId, state: 'ready', coverage: [], sessions: sessionsByProject().get(projectId) ?? [] } satisfies GuestSessionsSnapshot;
    },
  };
  return {
    host,
    pushProjects: (snapshot: GuestProjectsSnapshot) => projectListeners.forEach((l) => l(snapshot)),
    readCalls,
    projectUnsubscribed,
  };
};

const projectsSnapshot = (ids: string[]): GuestProjectsSnapshot => ({
  kind: 'projects', state: 'ready', projects: ids.map((id) => ({ id, name: id, directory: `/${id}` })),
});

/** Long enough that the periodic timer never fires mid-test; sweeps run via `sweep()`. */
const NO_SWEEP_TIMER = { sweepIntervalMs: 3_600_000 };

const record = () => {
  const found: Array<{ projectId: string; id: string; status: string; createdAt: number }> = [];
  return { found, onFound: (f: { projectId: string; session: { id: string; createdAt: number }; status: string }) => found.push({ projectId: f.projectId, id: f.session.id, status: f.status, createdAt: f.session.createdAt }) };
};

test('reports an adoptable session with its implied status and createdAt, across every registered project', async () => {
  const store = new Map([
    ['p1', [session('ses_a', { createdAt: 500 })]],
    ['p2', [session('ses_b', { activity: 'waiting-question', createdAt: 700 })]],
  ]);
  const { host, pushProjects } = fakeHost(() => store);
  const { found, onFound } = record();
  const watcher = watchOrphanSessions(host, () => new Set(), onFound, NO_SWEEP_TIMER);
  try {
    pushProjects(projectsSnapshot(['p1', 'p2']));
    await watcher.sweep();
    assert.deepEqual(found.sort((a, b) => a.id.localeCompare(b.id)), [
      { projectId: 'p1', id: 'ses_a', status: 'in_progress', createdAt: 500 },
      { projectId: 'p2', id: 'ses_b', status: 'review', createdAt: 700 },
    ]);
  } finally { watcher.dispose(); }
});

test('every sweep is checked, not just the first — so a session not active enough yet is still caught once it starts running', async () => {
  const store = new Map([['p1', [session('ses_new', { activity: 'idle', outcome: null })]]]);
  const { host, pushProjects } = fakeHost(() => store);
  const statuses: string[] = [];
  const watcher = watchOrphanSessions(host, () => new Set(), (f) => statuses.push(f.status), NO_SWEEP_TIMER);
  try {
    pushProjects(projectsSnapshot(['p1']));
    await watcher.sweep();
    assert.deepEqual(statuses, []);
    store.set('p1', [session('ses_new', { activity: 'running' })]);
    await watcher.sweep();
    assert.deepEqual(statuses, ['in_progress']);
  } finally { watcher.dispose(); }
});

test('a session already linked to a task is never reported', async () => {
  const store = new Map([['p1', [session('ses_a')]]]);
  const { host, pushProjects } = fakeHost(() => store);
  const { found, onFound } = record();
  const watcher = watchOrphanSessions(host, () => new Set(['ses_a']), onFound, NO_SWEEP_TIMER);
  try {
    pushProjects(projectsSnapshot(['p1']));
    await watcher.sweep();
    assert.deepEqual(found, []);
  } finally { watcher.dispose(); }
});

test('a dismissed session stays excluded while an unrelated sidebar session is still adopted', async () => {
  const store = new Map([['p1', [session('ses_dismissed'), session('ses_started_from_sidebar')]]]);
  const { host, pushProjects } = fakeHost(() => store);
  const ids: string[] = [];
  const dismissedSessionIds = new Set(['ses_dismissed']);
  const watcher = watchOrphanSessions(host, () => dismissedSessionIds, (f) => ids.push(f.session.id), NO_SWEEP_TIMER);
  try {
    pushProjects(projectsSnapshot(['p1']));
    await watcher.sweep();
    assert.deepEqual(ids, ['ses_started_from_sidebar']);
  } finally { watcher.dispose(); }
});

test('scales past the subscription cap: 64 projects swept by reads, with a single projects subscription', async () => {
  const ids = Array.from({ length: 64 }, (_, i) => `p${i}`);
  const store = new Map(ids.map((id) => [id, [session(`ses_${id}`)]]));
  const { host, pushProjects, readCalls } = fakeHost(() => store);
  const foundIds: string[] = [];
  const watcher = watchOrphanSessions(host, () => new Set(), (f) => foundIds.push(f.session.id), NO_SWEEP_TIMER);
  try {
    pushProjects(projectsSnapshot(ids));
    await watcher.sweep();
    assert.deepEqual(foundIds.sort(), ids.map((id) => `ses_${id}`).sort());
    assert.deepEqual([...readCalls].sort(), [...ids].sort());
  } finally { watcher.dispose(); }
});

test('sweeps never overlap — calls made while one runs coalesce into a single rerun', async () => {
  const projectListeners: Array<(snapshot: GuestProjectsSnapshot) => void> = [];
  const readCalls: string[] = [];
  let releaseFirstRead!: () => void;
  const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  let watcher: ReturnType<typeof watchOrphanSessions> | null = null;
  let rerunPromise: Promise<void> | undefined;
  const host: OrphanSessionsHost = {
    onProjects: async (listener) => { projectListeners.push(listener); return () => {}; },
    listSessions: async (projectId: string) => {
      readCalls.push(projectId);
      if (readCalls.length === 1) {
        // Two more sweep demands while the first is genuinely in flight.
        rerunPromise = watcher!.sweep();
        void watcher!.sweep();
        await firstReadGate;
      }
      return { kind: 'sessions', projectId, state: 'ready', coverage: [], sessions: [] } satisfies GuestSessionsSnapshot;
    },
  };
  watcher = watchOrphanSessions(host, () => new Set(), () => {}, NO_SWEEP_TIMER);
  try {
    projectListeners.forEach((l) => l(projectsSnapshot(['p1'])));
    while (rerunPromise === undefined) await Promise.resolve();
    releaseFirstRead();
    await rerunPromise;
    assert.equal(readCalls.length, 2);
  } finally { watcher?.dispose(); }
});

test('maxParallel bounds how many projects are read concurrently', async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `p${i}`);
  let inFlight = 0;
  let maxInFlight = 0;
  const projectListeners: Array<(snapshot: GuestProjectsSnapshot) => void> = [];
  const host: OrphanSessionsHost = {
    onProjects: async (listener) => { projectListeners.push(listener); return () => {}; },
    listSessions: async (projectId: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { kind: 'sessions', projectId, state: 'ready', coverage: [], sessions: [] } satisfies GuestSessionsSnapshot;
    },
  };
  const watcher = watchOrphanSessions(host, () => new Set(), () => {}, { ...NO_SWEEP_TIMER, maxParallel: 2 });
  try {
    projectListeners.forEach((l) => l(projectsSnapshot(ids)));
    await watcher.sweep();
    assert.ok(maxInFlight > 1, 'batches should actually run concurrently');
    assert.ok(maxInFlight <= 2, `concurrency ${maxInFlight} exceeded maxParallel 2`);
  } finally { watcher.dispose(); }
});

test('read failures surface as one bounded notice per changed count, not per sweep or per project', async () => {
  const errors: string[] = [];
  const failing = new Set<string>(['p_bad']);
  const listeners: Array<(snapshot: GuestProjectsSnapshot) => void> = [];
  const host: OrphanSessionsHost = {
    onProjects: async (listener) => { listeners.push(listener); return () => {}; },
    listSessions: async (projectId: string) => {
      if (failing.has(projectId)) throw new Error('read failed');
      return { kind: 'sessions', projectId, state: 'ready', coverage: [], sessions: [] } satisfies GuestSessionsSnapshot;
    },
  };
  const watcher = watchOrphanSessions(host, () => new Set(), () => {}, NO_SWEEP_TIMER, (error) => errors.push(error instanceof Error ? error.message : String(error)));
  try {
    listeners.forEach((l) => l(projectsSnapshot(['p_ok', 'p_bad'])));
    await watcher.sweep();
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /1 of 2 projects were unreadable/);
    // Same failure count on the next sweep — the existing notice is kept, no repeat.
    await watcher.sweep();
    assert.equal(errors.length, 1);
    // The count changed — one refreshed notice.
    failing.add('p_ok');
    await watcher.sweep();
    assert.equal(errors.length, 2);
    assert.match(errors[1] ?? '', /2 of 2 projects were unreadable/);
  } finally { watcher.dispose(); }
});

test('a project removed mid-sweep does not adopt from its stale in-flight read', async () => {
  const found: string[] = [];
  const listeners: Array<(snapshot: GuestProjectsSnapshot) => void> = [];
  let releaseP1!: () => void;
  const p1Gate = new Promise<void>((resolve) => { releaseP1 = resolve; });
  let watcher: ReturnType<typeof watchOrphanSessions> | null = null;
  let rerun: Promise<void> | undefined;
  const host: OrphanSessionsHost = {
    onProjects: async (listener) => { listeners.push(listener); return () => {}; },
    listSessions: async (projectId: string) => {
      if (projectId === 'p1') {
        // The project list will change while p1's read is still in flight.
        rerun = watcher!.sweep();
        await p1Gate;
        return { kind: 'sessions', projectId, state: 'ready', coverage: [], sessions: [session('ses_stale')] } satisfies GuestSessionsSnapshot;
      }
      return { kind: 'sessions', projectId, state: 'ready', coverage: [], sessions: [] } satisfies GuestSessionsSnapshot;
    },
  };
  watcher = watchOrphanSessions(host, () => new Set(), (f) => found.push(f.session.id), NO_SWEEP_TIMER);
  try {
    listeners.forEach((l) => l(projectsSnapshot(['p1', 'p2'])));
    while (rerun === undefined) await Promise.resolve();
    listeners.forEach((l) => l(projectsSnapshot(['p2'])));
    releaseP1();
    await rerun;
    await Promise.resolve();
    assert.deepEqual(found, []);
  } finally { watcher?.dispose(); }
});

test('a failed projects registration is reported through onError', async () => {
  const errors: unknown[] = [];
  const host: OrphanSessionsHost = {
    onProjects: async () => { throw new Error('no slots'); },
    listSessions: async (projectId: string) => ({ kind: 'sessions', projectId, state: 'ready', coverage: [], sessions: [] }) satisfies GuestSessionsSnapshot,
  };
  const watcher = watchOrphanSessions(host, () => new Set(), () => {}, NO_SWEEP_TIMER, (error) => errors.push(error));
  try {
    await Promise.resolve();
    assert.equal(errors.length, 1);
  } finally { watcher.dispose(); }
});

test('a changed project list is picked up by the next sweep', async () => {
  const store = new Map([['p1', [session('ses_p1')]], ['p3', [session('ses_p3')]]]);
  const { host, pushProjects, readCalls } = fakeHost(() => store);
  const ids: string[] = [];
  const watcher = watchOrphanSessions(host, () => new Set(), (f) => ids.push(f.session.id), NO_SWEEP_TIMER);
  try {
    pushProjects(projectsSnapshot(['p1', 'p2']));
    await watcher.sweep();
    assert.deepEqual(ids, ['ses_p1']);
    const readsAfterFirstSweep = readCalls.length;
    pushProjects(projectsSnapshot(['p3']));
    await watcher.sweep();
    assert.deepEqual(ids, ['ses_p1', 'ses_p3']);
    assert.deepEqual(readCalls.slice(readsAfterFirstSweep), ['p3']);
  } finally { watcher.dispose(); }
});

test('dispose stops sweeping and releases the projects subscription', async () => {
  const store = new Map([['p1', []]]);
  const { host, pushProjects, readCalls, projectUnsubscribed } = fakeHost(() => store);
  const watcher = watchOrphanSessions(host, () => new Set(), () => {}, NO_SWEEP_TIMER);
  pushProjects(projectsSnapshot(['p1']));
  await watcher.sweep();
  watcher.dispose();
  await Promise.resolve();
  assert.equal(projectUnsubscribed.length, 1);
  const readsAtDispose = readCalls.length;
  await watcher.sweep();
  assert.equal(readCalls.length, readsAtDispose);
});
