import type { GuestSessionsSnapshot, HostClient } from '@openchamber/sdk';
import { initialStatusForNewSession, isAdoptable } from '../domain/autoTask.ts';
import { DEFAULT_SYNC_OPTIONS, type SyncOptions } from '../domain/sync.ts';
import type { TaskStatus } from '../domain/task.ts';
import { describeHostError } from './workspace.ts';

export type OrphanSessionsHost = Pick<HostClient, 'onProjects' | 'listSessions'>;

export type OrphanFound = { projectId: string; session: { id: string; title: string; createdAt: number }; status: TaskStatus };

export type OrphanSweepOptions = Partial<SyncOptions> & {
  /** How often to re-scan every registered project. */
  sweepIntervalMs?: number;
  /** Concurrent `listSessions` reads per sweep. */
  maxParallel?: number;
};

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_MAX_PARALLEL = 4;


/**
 * Watches every registered project for a session with no task pointed at
 * it yet, and reports it — with the status its current activity implies —
 * on every sweep, not just once. "Going forward only" (not for sessions
 * that pre-date this feature) is enforced by the caller comparing
 * `session.createdAt` against a persisted watermark (`store/orphanWatermark.ts`),
 * not by this watcher: a page-type extension can't stay running across the
 * navigation that starting a session itself causes, so there is no
 * reliable in-memory "first snapshot" to treat as a baseline here — only a
 * persisted cutoff survives the page closing and reopening.
 *
 * The host allows at most 32 active subscriptions per iframe, so watching
 * N projects with N `onSessions` subscriptions breaks every other
 * subscription consumer once the host has ~32 projects registered. This
 * watcher therefore holds exactly one subscription (`onProjects`, for the
 * project list itself) and sweeps all projects with one-off `listSessions`
 * reads, which never count against that cap: bounded parallelism, no
 * overlapping sweeps (calls while one runs coalesce into a single rerun),
 * and failures surface as one bounded `onError` whenever the failure count
 * changes ("N of M projects unreadable") — unreachable projects stay
 * visible without per-sweep or per-project spam.
 */
export const watchOrphanSessions = (
  host: OrphanSessionsHost,
  getLinkedSessionIds: () => ReadonlySet<string>,
  onFound: (found: OrphanFound) => void,
  options: OrphanSweepOptions = DEFAULT_SYNC_OPTIONS,
  onError?: (error: unknown) => void,
) => {
  const { sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS, maxParallel = DEFAULT_MAX_PARALLEL, ...rest } = options;
  const syncOptions: SyncOptions = { ...DEFAULT_SYNC_OPTIONS, ...rest };

  let disposed = false;
  let projectIds: string[] = [];
  /** Failure count of the previous sweep, so one notice per changed count — not per sweep or project. */
  let lastFailureCount = 0;

  const applySnapshot = (projectId: string, snapshot: GuestSessionsSnapshot) => {
    if (disposed) return;
    const linked = getLinkedSessionIds();
    for (const session of snapshot.sessions) {
      if (!isAdoptable(session, linked)) continue;
      const status = initialStatusForNewSession(session, syncOptions);
      if (status) onFound({ projectId, session: { id: session.id, title: session.title, createdAt: session.createdAt }, status });
    }
  };

  const runSweep = async () => {
    const ids = [...projectIds];
    let firstError: unknown;
    let failures = 0;
    for (let start = 0; start < ids.length; start += maxParallel) {
      if (disposed) return;
      const batch = ids.slice(start, start + maxParallel);
      const results = await Promise.allSettled(batch.map((projectId) => host.listSessions(projectId)));
      // A project removed while its read was in flight must not adopt from
      // the stale result — only projects still registered count at all.
      const stillRegistered = new Set(projectIds);
      results.forEach((result, index) => {
        const projectId = batch[index];
        if (projectId === undefined || !stillRegistered.has(projectId)) return;
        if (result.status === 'fulfilled') {
          applySnapshot(projectId, result.value);
          return;
        }
        failures += 1;
        if (firstError === undefined) firstError = result.reason;
      });
    }
    if (!disposed && failures > 0 && failures !== lastFailureCount) {
      // One bounded notice per changed failure count: a project that stays
      // unreachable keeps the existing warning instead of spamming, and the
      // count moving (up or down) refreshes it.
      const summary = `${failures} of ${ids.length} projects were unreadable during the session sweep (${describeHostError(firstError)})`;
      onError?.(new Error(summary));
    }
    lastFailureCount = failures;
  };

  let sweepChain: Promise<void> = Promise.resolve();
  let queued = false;
  const sweep = (): Promise<void> => {
    if (disposed || queued) return sweepChain;
    queued = true;
    sweepChain = sweepChain.then(() => {
      queued = false;
      return runSweep();
    });
    return sweepChain;
  };

  const stopProjectsPromise = host.onProjects((snapshot) => {
    if (disposed) return;
    const ids = snapshot.projects.map((project) => project.id);
    const changed = ids.length !== projectIds.length || ids.some((id, index) => id !== projectIds[index]);
    if (!changed) return;
    projectIds = ids;
    // The first snapshot doubles as the initial sweep; later ones only fire on real changes.
    void sweep();
  });
  stopProjectsPromise.catch((error: unknown) => {
    if (!disposed) onError?.(error);
  });

  const timer = setInterval(() => { void sweep(); }, sweepIntervalMs);

  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    void stopProjectsPromise.then((stop) => stop(), () => undefined);
  };

  return { dispose, sweep };
};
