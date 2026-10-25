import type { GuestWorktreesSnapshot, HostClient } from '@openchamber/sdk';
import { worktreeLinkState } from '../domain/unlink.ts';
import type { Task } from '../domain/task.ts';
import { acquireLiveSyncSubscription, releaseLiveSyncSubscription } from './subscriptionBudget.ts';

export type WorktreeSyncHost = Pick<HostClient, 'onWorktrees' | 'listWorktrees'>;

/** Cadence of the fallback reads for projects that could not get a live subscription. */
const FALLBACK_POLL_INTERVAL_MS = 15_000;

type WatchEntry = {
  promise: Promise<() => void>;
  /** The unsubscribe handle once registration resolves; null while still pending. */
  stop: (() => void) | null;
  /** Gives back the budget slot exactly once, but only after the real unsubscribe happened (or registration refused). */
  release: () => void;
};

/**
 * Watches the live worktree state behind every task that has one linked, and
 * reports the task when its worktree is deleted from the sidebar — the link
 * must not outlive what it points at. Same shape as `sessionSync`: one
 * subscription per distinct project among those tasks, released once no
 * watched task still needs it, and budget-gated the same way (see
 * `subscriptionBudget`) — an over-budget project falls back to periodic
 * one-off `listWorktrees` reads instead of going stale. Those fallback
 * passes never overlap, and a failing read is reported through
 * `onWatchError` once per project until it succeeds again.
 */
export const createWorktreeSync = (
  host: WorktreeSyncHost,
  onWorktreeGone: (taskId: string) => void,
  onWatchError?: (projectId: string, error: unknown) => void,
) => {
  const subscriptions = new Map<string, WatchEntry>();
  let tasksById = new Map<string, Task>();
  /** Projects without a live subscription (budget spent or registration refused), kept fresh by fallback reads. */
  const pollingProjects = new Set<string>();
  /** Polled projects whose last fallback read failed, so each failure episode is reported once. */
  const failingProjects = new Set<string>();
  /** True while a fallback pass runs, so an interval tick skips instead of overlapping it. */
  let polling = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const applySnapshot = (projectId: string, snapshot: GuestWorktreesSnapshot) => {
    if (disposed) return;
    for (const task of tasksById.values()) {
      if (task.projectId !== projectId || !task.worktree) continue;
      if (worktreeLinkState(task.worktree.directory, snapshot) === 'gone') onWorktreeGone(task.id);
    }
  };

  /**
   * One fallback pass: sequential one-off reads, so projects beyond the
   * budget still get gone updates. A tick that arrives while a pass is still
   * running is skipped, so a slow read never stacks passes on top of each
   * other. A failing project is reported once through `onWatchError`; the
   * first successful read ends that episode silently.
   */
  const poll = async () => {
    if (disposed || polling) return;
    polling = true;
    try {
      for (const projectId of [...pollingProjects]) {
        if (disposed || !pollingProjects.has(projectId)) continue;
        try {
          const snap = await host.listWorktrees(projectId);
          failingProjects.delete(projectId);
          if (!disposed && pollingProjects.has(projectId)) applySnapshot(projectId, snap);
        } catch (error) {
          // One unreadable project must not stop the rest; the next pass retries.
          if (!failingProjects.has(projectId)) {
            failingProjects.add(projectId);
            onWatchError?.(projectId, error);
          }
        }
      }
    } finally {
      polling = false;
    }
  };

  const updatePollTimer = () => {
    if (disposed) return;
    if (pollingProjects.size > 0 && pollTimer === null) {
      pollTimer = setInterval(() => { void poll(); }, FALLBACK_POLL_INTERVAL_MS);
    } else if (pollingProjects.size === 0 && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const watch = (projectId: string) => {
    const capError = acquireLiveSyncSubscription();
    if (capError) {
      pollingProjects.add(projectId);
      onWatchError?.(projectId, capError);
      return;
    }
    let released = false;
    const entry: WatchEntry = {
      promise: host.onWorktrees(projectId, (snapshot) => applySnapshot(projectId, snapshot)),
      stop: null,
      release: () => {
        if (released) return;
        released = true;
        releaseLiveSyncSubscription();
      },
    };
    subscriptions.set(projectId, entry);
    void entry.promise.then((stop) => {
      // Unwanted by the time registration landed — replaced by a newer watch
      // or torn down while pending — so end it immediately.
      if (subscriptions.get(projectId) !== entry || disposed) {
        stop();
        entry.release();
        return;
      }
      pollingProjects.delete(projectId);
      failingProjects.delete(projectId);
      entry.stop = stop;
      // Live again: if this was the last polled project, stop the idle timer.
      updatePollTimer();
    }, (error: unknown) => {
      // Registration refused (budget spent elsewhere, host limit, …): give
      // the slot back and drop the entry so a later sync() can retry; the
      // fallback reads keep the project syncing meanwhile.
      const current = subscriptions.get(projectId) === entry;
      if (current) subscriptions.delete(projectId);
      entry.release();
      if (!disposed && current) {
        pollingProjects.add(projectId);
        updatePollTimer();
        onWatchError?.(projectId, error);
      }
    });
  };

  const stopEntry = (entry: WatchEntry) => {
    if (entry.stop) {
      entry.stop();
      entry.stop = null;
      entry.release();
    }
    // Registration still pending: no real unsubscribe exists yet, so the
    // slot stays held until the promise settles — releasing it now could
    // admit another subscription while the host still counts this one.
  };

  /** Call whenever the task list changes (reload, link, create, delete, move). */
  const sync = (tasks: readonly Task[]) => {
    if (disposed) return;
    tasksById = new Map(tasks.map((task) => [task.id, task]));
    const needed = new Set(tasks.filter((task) => task.worktree && task.projectId).map((task) => task.projectId as string));
    // Tear down unneeded watches first, so slots they free are reusable by
    // the new watches below within this same sync.
    for (const [projectId, entry] of subscriptions) {
      if (needed.has(projectId)) continue;
      subscriptions.delete(projectId);
      stopEntry(entry);
    }
    for (const projectId of pollingProjects) {
      if (!needed.has(projectId)) {
        pollingProjects.delete(projectId);
        failingProjects.delete(projectId);
      }
    }
    // Polled projects are retried too: a slot may have freed up since the last sync.
    for (const projectId of needed) {
      if (!subscriptions.has(projectId)) watch(projectId);
    }
    updatePollTimer();
  };

  const dispose = () => {
    disposed = true;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const entry of subscriptions.values()) stopEntry(entry);
    subscriptions.clear();
    pollingProjects.clear();
    failingProjects.clear();
  };

  return { sync, dispose, poll };
};
