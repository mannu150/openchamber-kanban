import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostRequestError, type GuestDirectoryCoverage, type GuestProject, type GuestSessionRecord, type GuestSessionsSnapshot, type GuestWorktreesSnapshot } from '@openchamber/sdk';
import { describeHostError, describeStartSessionDelivery, fetchSessions, fetchWorktrees, projectForDirectory, type WorkspaceHost } from '../src/host/workspace.ts';

const project = (id: string, directory: string): GuestProject => ({ id, name: id, directory });

const session = (id: string, updatedAt: number, overrides: Partial<GuestSessionRecord> = {}): GuestSessionRecord => ({
  id, title: id.toUpperCase(), projectId: 'p1', directory: '/x', parentId: null, createdAt: 1, updatedAt, archivedAt: null, worktree: null, activity: 'idle', outcome: null, items: [],
  ...overrides,
});

const unusedRead = async (): Promise<never> => { throw new Error('unexpected read'); };

test('fetchSessions reads once via listSessions, newest first, parents only, archived separated, coverage kept', async () => {
  const coverage: GuestDirectoryCoverage[] = [{ directory: '/x', state: 'ready' }];
  let reads = 0;
  const host: WorkspaceHost = {
    onProjects: async () => () => {},
    listSessions: async () => {
      reads += 1;
      return {
        kind: 'sessions', projectId: 'p1', state: 'ready', coverage,
        sessions: [session('a', 10), session('b', 20), session('sub', 30, { parentId: 'a' }), session('arch', 40, { archivedAt: 99 })],
      } satisfies GuestSessionsSnapshot;
    },
    listWorktrees: unusedRead,
  };
  const result = await fetchSessions(host, 'p1');
  assert.equal(result.complete, true);
  assert.deepEqual(result.sessions.map((s) => s.id), ['b', 'a']);
  assert.deepEqual(result.allSessions.map((s) => s.id), ['arch', 'b', 'a']);
  assert.deepEqual(result.coverage, coverage);
  assert.equal(reads, 1);
});

test('fetchSessions reports incomplete on an error snapshot instead of throwing', async () => {
  const host: WorkspaceHost = {
    onProjects: async () => () => {},
    listSessions: async () => ({ kind: 'sessions', projectId: 'p1', state: 'error', coverage: [], sessions: [] }) as GuestSessionsSnapshot,
    listWorktrees: unusedRead,
  };
  const result = await fetchSessions(host, 'p1');
  assert.equal(result.complete, false);
  assert.deepEqual(result.sessions, []);
});

test('fetchSessions retries while the store is loading and resolves once ready', async () => {
  let reads = 0;
  const host: WorkspaceHost = {
    onProjects: async () => () => {},
    listSessions: async () => {
      reads += 1;
      return reads === 1
        ? { kind: 'sessions', projectId: 'p1', state: 'loading', coverage: [], sessions: [] } as GuestSessionsSnapshot
        : { kind: 'sessions', projectId: 'p1', state: 'ready', coverage: [], sessions: [session('a', 10)] } as GuestSessionsSnapshot;
    },
    listWorktrees: unusedRead,
  };
  const result = await fetchSessions(host, 'p1');
  assert.equal(result.complete, true);
  assert.deepEqual(result.sessions.map((s) => s.id), ['a']);
  assert.equal(reads, 2);
});

test('fetchSessions hands back the loading snapshot once the deadline passes — incomplete, not empty-trusted', async () => {
  let reads = 0;
  const host: WorkspaceHost = {
    onProjects: async () => () => {},
    listSessions: async () => {
      reads += 1;
      return { kind: 'sessions', projectId: 'p1', state: 'loading', coverage: [], sessions: [session('a', 10)] } as GuestSessionsSnapshot;
    },
    listWorktrees: unusedRead,
  };
  const result = await fetchSessions(host, 'p1', 0);
  assert.equal(result.complete, false);
  assert.equal(reads, 1);
});

test('fetchSessions rejects when the read itself fails', async () => {
  const failure = new HostRequestError('NOT_GRANTED', 'denied');
  const host: WorkspaceHost = {
    onProjects: async () => () => {},
    listSessions: async () => { throw failure; },
    listWorktrees: unusedRead,
  };
  await assert.rejects(fetchSessions(host, 'p1'), failure);
});

test('fetchWorktrees resolves ready reads and reports incomplete ones', async () => {
  const ready: GuestWorktreesSnapshot = { kind: 'worktrees', projectId: 'p1', state: 'ready', worktrees: [{ directory: '/d', name: 'd', branch: 'b', status: 'ready' }] };
  const host: WorkspaceHost = {
    onProjects: async () => () => {},
    listSessions: unusedRead,
    listWorktrees: async () => ready,
  };
  const result = await fetchWorktrees(host, 'p1');
  assert.equal(result.complete, true);
  assert.deepEqual(result.worktrees, ready.worktrees);

  const loadingHost: WorkspaceHost = {
    onProjects: async () => () => {},
    listSessions: unusedRead,
    listWorktrees: async () => ({ kind: 'worktrees', projectId: 'p1', state: 'loading', worktrees: [] }) as GuestWorktreesSnapshot,
  };
  assert.equal((await fetchWorktrees(loadingHost, 'p1', 0)).complete, false);
});

test('projectForDirectory matches exact and nested worktree paths, else null', () => {
  const projects = [project('a', '/repo/a'), project('b', '/repo/b')];
  assert.equal(projectForDirectory(projects, '/repo/a')?.id, 'a');
  assert.equal(projectForDirectory(projects, '/repo/a/.worktrees/foo')?.id, 'a');
  assert.equal(projectForDirectory(projects, '/other'), null);
  assert.equal(projectForDirectory(projects, null), null);
});

test('describeHostError gives an actionable message for known codes and falls back otherwise', () => {
  assert.match(describeHostError(new HostRequestError('NOT_GRANTED', 'x')), /permission/);
  assert.match(describeHostError(new HostRequestError('HOST_TIMEOUT', 'x')), /did not answer/);
  assert.equal(describeHostError(new Error('boom')), 'boom');
  assert.equal(describeHostError('plain'), 'plain');
});

test('describeStartSessionDelivery is null only when the description was actually sent', () => {
  assert.equal(describeStartSessionDelivery('sent'), null);
  assert.match(describeStartSessionDelivery('no-model') ?? '', /model/);
  assert.match(describeStartSessionDelivery('skipped') ?? '', /skipped/);
  assert.match(describeStartSessionDelivery('failed') ?? '', /failed/);
});
