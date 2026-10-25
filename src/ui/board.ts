import type { GuestProject, HostClient } from '@openchamber/sdk';
import { mountBanner, mountButton, mountSearchField, mountSelect, mountSpinner } from '@openchamber/sdk/ui';
import { applyPatch, createTask, DEFAULT_TASK_TITLE, STATUSES, STATUS_LABELS, type Task, type TaskPatch, type TaskStatus } from '../domain/task.ts';
import { ALL_PROJECTS, NO_PROJECT, groupColumns, planDrop, rankAtEnd, type BoardFilter } from '../domain/board.ts';
import { deleteTask, loadTasks, saveTask } from '../store/taskStore.ts';
import { loadPrefs, savePrefs, type Prefs } from '../store/prefs.ts';
import { loadOrphanWatermark, saveOrphanWatermark } from '../store/orphanWatermark.ts';
import { loadDismissedSessions, saveDismissedSessions } from '../store/dismissedSessions.ts';
import { describeHostError, describeStartSessionDelivery, fetchSessions, fetchWorktrees, watchProjects } from '../host/workspace.ts';
import { fetchServiceBranches } from '../host/branchService.ts';
import { createSessionSync } from '../host/sessionSync.ts';
import { createWorktreeSync } from '../host/worktreeSync.ts';
import { watchOrphanSessions } from '../host/orphanSessions.ts';
import { DEFAULT_SYNC_OPTIONS } from '../domain/sync.ts';
import { sessionLinkState, worktreeLinkState, type SessionGoneReason, type SessionsView, type WorktreesView } from '../domain/unlink.ts';
import { sessionTitleForTask, titleForOrphanSession } from '../domain/autoTask.ts';
import { buildBaseBranchOptions, describeWorktreeOption, hasKnownBranches, resolveTaskWorktree } from '../domain/worktree.ts';
import { mountTaskDetail } from './detail.ts';
import { injectStyles } from './styles.ts';
import { insertionTarget } from './dnd.ts';
import { el } from './dom.ts';

export type BoardHost = Pick<
  HostClient,
  'storage' | 'onProjects' | 'onSessions' | 'onWorktrees' | 'listSessions' | 'listWorktrees' | 'openSession' | 'startSession' | 'serviceRequest' | 'toast' | 'setBadge'
>;

/**
 * Agent state drives task status, one direction only: the agent working
 * moves a task to In Progress, and the agent finishing, asking a question,
 * hitting a permission prompt, or failing moves it to Review — never to
 * Done. A task the user marked Done stays there regardless of what its
 * session does afterwards; only the user's own Mark Done ever sets it.
 */
const SYNC_OPTIONS = DEFAULT_SYNC_OPTIONS;

const EXTENSION_ID = 'kanban-board';
/** Never dereferenced by the host; only shown as this task's chip link. */
const taskUrl = (id: string) => `https://kanban.local/tasks/${id}`;

export const mountKanbanBoard = (host: BoardHost, root: Element) => {
  injectStyles();
  root.replaceChildren();

  const page = el('div', 'kb-page');
  root.append(page);

  const toolbar = el('div', 'kb-toolbar'); page.append(toolbar);
  const projectSelectWrap = el('div'); toolbar.append(projectSelectWrap);
  const searchWrap = el('div', 'grow'); toolbar.append(searchWrap);
  const refresh = mountButton(toolbar, { label: 'Refresh', variant: 'ghost', onClick: () => { void reload(); } });

  const addRow = el('div', 'kb-row'); page.append(addRow);
  const bannerSlot = el('div'); page.append(bannerSlot);
  bannerSlot.hidden = true;
  const banner = mountBanner(bannerSlot, { tone: 'error', title: '' });
  const showBanner = (title: string, body?: string, tone: 'error' | 'warning' | 'info' = 'error') => {
    bannerSlot.hidden = false; banner.update({ tone, title, body });
  };
  const clearBanner = () => { bannerSlot.hidden = true; };
  const notify = (error: unknown) => showBanner('Something went wrong', describeHostError(error));

  // No title field here on purpose: a click creates a real, persisted task right
  // away (title "New task", editable immediately in the popup that opens for it),
  // instead of asking for a title before there's anything to attach it to.
  const add = mountButton(addRow, {
    label: 'Add task',
    onClick: () => {
      void (async () => {
        try {
          const task = createTask(
            { title: DEFAULT_TASK_TITLE, projectId: filter.projectId === ALL_PROJECTS || filter.projectId === NO_PROJECT ? null : filter.projectId },
            rankAtEnd(tasks, 'backlog'),
          );
          add.update({ loading: true });
          await saveTask(host, task);
          setTasks([...tasks, task]);
          clearBanner();
          render();
          openDetail(task.id);
        } catch (error) { notify(error); }
        finally { add.update({ loading: false }); }
      })();
    },
  });

  const columnsRoot = el('div', 'kb-columns'); page.append(columnsRoot);
  const spinnerSlot = el('div'); page.append(spinnerSlot);

  let tasks: Task[] = [];
  let projects: GuestProject[] = [];
  let prefs: Prefs = { projectId: ALL_PROJECTS, query: '', openTaskId: null };
  let filter: BoardFilter = { projectId: ALL_PROJECTS, query: '' };
  let detail: { dispose: () => void } | null = null;
  let draggingId: string | null = null;
  let disposed = false;

  /** The one place `tasks` changes, so the session/worktree watchers always see the current set. */
  const setTasks = (next: Task[]) => {
    tasks = next;
    sessionSync.sync(tasks);
    worktreeSync.sync(tasks);
  };

  /**
   * The status this mount last attempted to write for a task via the live
   * sync, whether it succeeded or not. A session's `onSessions` snapshot
   * fires continuously while it runs, so without this a single persistent
   * save failure would retry the identical write (and re-show the error)
   * on every tick. Only a genuinely different target status — the agent
   * moving to a new activity — is allowed to try again.
   */
  let lastAttemptedStatus = new Map<string, TaskStatus>();

  const applyAgentStatusChange = (taskId: string, next: TaskStatus) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === next) return;
    if (lastAttemptedStatus.get(taskId) === next) return;
    lastAttemptedStatus.set(taskId, next);
    // Landing in Review this way is a change you didn't make yourself, so it's flagged until you look at it.
    // Moving anywhere else (e.g. back to In Progress) clears a stale flag that's no longer about this status.
    const updated = applyPatch(task, { status: next, needsAttentionSince: next === 'review' ? Date.now() : null });
    setTasks(tasks.map((t) => (t.id === taskId ? updated : t)));
    render();
    void saveTask(host, updated).catch((error) => { notify(error); void reload(); });
  };

  /**
   * Clears one link on a task (its session, or its worktree) after the thing
   * it points at was deleted or archived on the host. Session deletion uses
   * deleteTaskForGoneSession instead. The state and save are unconditional —
   * the caller checked the guard — but every caller updates its own state
   * synchronously first, so a repeated report is a no-op.
   * `message` null means stay quiet (reconciliation reports one summary
   * instead of one toast per task).
   */
  const clearTaskLink = (taskId: string, patch: TaskPatch, message: string | null): boolean => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const updated = applyPatch(task, patch);
    setTasks(tasks.map((t) => (t.id === taskId ? updated : t)));
    render();
    void saveTask(host, updated)
      .then(() => { if (message) void host.toast({ kind: 'info', message }).catch(() => undefined); })
      .catch((error) => { notify(error); void reload(); });
    return true;
  };

  /**
   * A task's linked session was deleted or archived from the sidebar. A
   * deleted session removes the task; an archived session only clears the
   * link, so the card no longer claims a session that "Open Chat" cannot open.
   */
  const deleteTaskForGoneSession = (taskId: string, message: string | null): boolean => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;
    void deleteTask(host, task.id)
      .then(() => {
        if (prefs.openTaskId === task.id) void persistOpenTask(null);
        if (message) void host.toast({ kind: 'info', message }).catch(() => undefined);
      })
      .catch((error) => { notify(error); void reload(); });
    setTasks(tasks.filter((candidate) => candidate.id !== task.id));
    detail?.dispose();
    detail = null;
    render();
    return true;
  };

  const onSessionGone = (taskId: string, sessionId: string, reason: SessionGoneReason) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.sessionId !== sessionId) return;
    if (reason === 'deleted') {
      deleteTaskForGoneSession(taskId, `Deleted "${task.title}" — its session was deleted.`);
    } else {
      clearTaskLink(taskId, { sessionId: null }, `Unlinked "${task.title}" — its session was archived.`);
    }
  };

  /** A task's worktree was deleted from the sidebar; the recorded worktree no longer points anywhere. */
  const onWorktreeGone = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !task.worktree) return;
    clearTaskLink(taskId, { worktree: null }, `Cleared the worktree link on "${task.title}" — that worktree was deleted.`);
  };

  /**
   * A live-watch subscription could not be established (the host's
   * 32-per-frame cap is shared with everything else in this iframe).
   * Nothing is lost permanently — the affected projects keep syncing
   * through periodic reads, and reload still reads everything.
   */
  const onLiveSyncError = (projectId: string, error: unknown) => {
    if (disposed) return;
    showBanner('Live updates limited', `${describeHostError(error)} Affected projects keep syncing through periodic reads (~15s) instead of live subscriptions; Refresh always loads fresh data.`, 'warning');
  };

  const sessionSync = createSessionSync(host, SYNC_OPTIONS, applyAgentStatusChange, onSessionGone, onLiveSyncError);
  const worktreeSync = createWorktreeSync(host, onWorktreeGone, onLiveSyncError);

  /** A deleted task's session stays out of automatic adoption, even after a reload. */
  let dismissedSessionIds = new Set<string>();
  const excludedSessionIds = () => new Set([
    ...dismissedSessionIds,
    ...tasks.flatMap((task) => task.sessionId ? [task.sessionId] : []),
  ]);
  /**
   * Every session id this mount has ever tried to adopt, success or
   * failure. A live session's `onSessions` snapshot fires continuously
   * while it runs, so this must be a permanent-for-this-mount guard, not
   * cleared on failure — otherwise a single persistent storage error turns
   * into a retry-and-error-toast storm on every snapshot tick. A fresh
   * `Refresh`/reopen gets a clean slate via `reload()` below.
   */
  let attemptedSessions = new Set<string>();

  /**
   * How many `startSession` calls (for any task) are currently in flight.
   * While this is above zero, adoption is paused — not just guarded by
   * `attemptedSessions`, which can only be populated *after* `startSession`
   * resolves with the session's id. The host can report the session it is
   * in the middle of creating to this mount's own live orphan watcher
   * before that promise resolves, so without this, a session this very
   * call is about to claim as its own task's link can be adopted as a
   * second, duplicate task first. Decremented the moment the id is known
   * and claimed in `attemptedSessions`, not held for the whole call, so a
   * genuinely unrelated orphan elsewhere is paused for as little as
   * possible.
   */
  let startingAgents = 0;

  /**
   * Retries a critical link-save a few times before giving up. Used only
   * right after a real session has already been created (`startSession`
   * succeeded) or an existing one deliberately linked — at that point a
   * transient storage failure (the kind that produced "HOST_REJECTED" once
   * before) must not silently lose the link, since the session is already
   * real, already possibly running, and already claimed in
   * `attemptedSessions` so the orphan watcher won't duplicate it. Losing
   * the link here would leave it on neither path: not on this task, and
   * never auto-adopted either.
   */
  const saveTaskRetrying = async (next: Task, attempts = 3): Promise<void> => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { await saveTask(host, next); return; }
      catch (error) {
        if (attempt === attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  };
  /**
   * The persisted "going forward" cutoff (see `store/orphanWatermark.ts`):
   * a session is only adoptable if it was created at or after this time.
   * `Infinity` until `reload()` has actually loaded or set it, so nothing
   * is adopted on a race before we know the real value.
   */
  let orphanWatermark = Infinity;

  /**
   * A session with no task yet, created at or after the persisted
   * watermark, gets adopted as a new task — In Progress while it's
   * running, Review once it needs you (a question, a permission prompt, or
   * it already finished). Sessions older than the watermark (pre-dating
   * this feature's first use) are left alone, by design.
   */
  const adoptRunningSession = (projectId: string, session: { id: string; title: string; createdAt: number }, status: TaskStatus) => {
    if (disposed || startingAgents > 0 || attemptedSessions.has(session.id) || excludedSessionIds().has(session.id)) return;
    if (session.createdAt < orphanWatermark) return;
    attemptedSessions.add(session.id);
    void (async () => {
      try {
        const task: Task = {
          ...createTask({ title: titleForOrphanSession(session, projects.find((p) => p.id === projectId)?.name ?? null), projectId, status }, rankAtEnd(tasks, status)),
          sessionId: session.id,
          // Landing straight in Review (already finished, or needs you) is just as unseen as any other automatic move there.
          needsAttentionSince: status === 'review' ? Date.now() : null,
        };
        await saveTask(host, task);
        setTasks([...tasks, task]);
        render();
        void host.toast({ kind: 'info', message: `Added "${task.title}" to the board (${STATUS_LABELS[status]}) — found a session running with no task.` }).catch(() => undefined);
      } catch (error) { notify(error); }
    })();
  };
  let orphanWatcher: { dispose: () => void } | null = null;

  const projectOptions = () => [
    { id: ALL_PROJECTS, label: 'All projects' },
    { id: NO_PROJECT, label: 'No project' },
    ...projects.map((p) => ({ id: p.id, label: p.name })),
  ];
  const projectSelect = mountSelect(projectSelectWrap, {
    label: 'Project', value: ALL_PROJECTS, options: projectOptions(), searchable: true,
    onChange: (value) => {
      filter = { ...filter, projectId: value }; projectSelect.update({ value });
      void savePrefs(host, { ...prefs, projectId: value }).catch(() => undefined);
      prefs = { ...prefs, projectId: value };
      render();
    },
  });
  const searchField = mountSearchField(searchWrap, {
    value: filter.query, placeholder: 'Search tasks, branch, session…',
    onChange: (value) => {
      filter = { ...filter, query: value }; searchField.update({ value });
      void savePrefs(host, { ...prefs, query: value }).catch(() => undefined);
      prefs = { ...prefs, query: value };
      render();
    },
  });

  /**
   * Returns the save's promise — most callers fire-and-forget it (`void`),
   * but the two navigate-away paths below must await it: `host.openSession`
   * can tear this page down as part of the same call, before a
   * fire-and-forget write to storage has actually reached the host, which
   * would leave the old value persisted and this task reopening the next
   * time the board loads.
   */
  const persistOpenTask = (id: string | null): Promise<void> => {
    prefs = { ...prefs, openTaskId: id };
    return savePrefs(host, prefs).catch(() => undefined);
  };

  const closeDetail = () => {
    detail?.dispose(); detail = null;
    void persistOpenTask(null);
  };

  /** Opening a task — its chat or its detail popup — is what "reviewed" means; clear any unseen marker. */
  const markReviewed = (task: Task) => {
    if (task.needsAttentionSince === null) return;
    const updated = applyPatch(task, { needsAttentionSince: null });
    setTasks(tasks.map((t) => (t.id === task.id ? updated : t)));
    render();
    void saveTask(host, updated).catch((error) => notify(error));
  };

  const openDetail = (id: string) => {
    const found = tasks.find((t) => t.id === id);
    if (!found) return;
    markReviewed(found);
    const task = tasks.find((t) => t.id === id) ?? found;
    detail?.dispose();
    void persistOpenTask(id);
    detail = mountTaskDetail(root, {
      task,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      onClose: closeDetail,
      onSave: async (patch) => {
        const updated = applyPatch(task, patch);
        await saveTask(host, updated);
        setTasks(tasks.map((t) => (t.id === task.id ? updated : t)));
        render();
        closeDetail();
        openDetail(task.id);
      },
      onDelete: async () => {
        const sessionId = task.sessionId;
        const alreadyDismissed = sessionId !== null && dismissedSessionIds.has(sessionId);
        if (sessionId && !alreadyDismissed) {
          // Persist the dismissal before removing the task. The orphan watcher
          // can receive a session snapshot at any time, including during this
          // delete, and must see the exclusion before the task link disappears.
          dismissedSessionIds.add(sessionId);
          try {
            await saveDismissedSessions(host, dismissedSessionIds);
          } catch (error) {
            dismissedSessionIds.delete(sessionId);
            throw error;
          }
        }
        try {
          await deleteTask(host, task.id);
        } catch (error) {
          if (sessionId && !alreadyDismissed) {
            dismissedSessionIds.delete(sessionId);
            void saveDismissedSessions(host, dismissedSessionIds).catch(() => undefined);
          }
          throw error;
        }
        setTasks(tasks.filter((t) => t.id !== task.id));
        closeDetail();
        render();
      },
      onOpenChat: async (sessionId) => {
        // Awaited, not fire-and-forget, and before navigating away — `host.openSession`
        // can tear this page down as part of the same call, before a fire-and-forget
        // write actually reaches the host, which would leave the old value persisted
        // and this task reopening the next time the board loads.
        await persistOpenTask(null);
        await host.openSession(sessionId);
        closeDetail();
      },
      onLinkSession: async (sessionId, sessionProjectId) => {
        // Claimed immediately, before the save, so the orphan watcher never adopts this
        // session as a second task even if the save below is slow or ultimately fails.
        // The project is stored too: without it, neither the live status/unlink watchers
        // nor reconciliation can cover a task linked this way.
        attemptedSessions.add(sessionId);
        const updated = applyPatch(task, {
          sessionId,
          ...(sessionProjectId ? { projectId: sessionProjectId } : {}),
          status: task.status === 'backlog' ? 'todo' : task.status,
        });
        await saveTaskRetrying(updated);
        if (dismissedSessionIds.delete(sessionId)) {
          // Explicitly linking a dismissed session brings it back by choice.
          // If cleanup fails, retain the in-memory dismissal; the new task
          // link still prevents adoption, and a later delete will keep it out.
          try { await saveDismissedSessions(host, dismissedSessionIds); }
          catch { dismissedSessionIds.add(sessionId); }
        }
        setTasks(tasks.map((t) => (t.id === task.id ? updated : t)));
        render();
        closeDetail();
        openDetail(task.id);
      },
      onUnlinkSession: async () => {
        const updated = applyPatch(task, { sessionId: null });
        await saveTask(host, updated);
        setTasks(tasks.map((t) => (t.id === task.id ? updated : t)));
        render();
        closeDetail();
        openDetail(task.id);
      },
      loadSessionsForProject: async (projectId) => {
        const result = await fetchSessions(host, projectId);
        return result.sessions.map((s) => ({ id: s.id, title: s.title, activity: s.activity }));
      },
      loadWorktreeInfo: async (projectId) => {
        const result = await fetchWorktrees(host, projectId);
        // The local git-branch service gives the real repository branch list, same
        // as OpenChamber's own "New Worktree" dialog; falls back to worktree-derived
        // branches (silently — see fetchServiceBranches) when it's not approved,
        // running, or supported on this platform.
        const directory = projects.find((p) => p.id === projectId)?.directory ?? null;
        const serviceBranches = directory ? await fetchServiceBranches(host, directory) : null;
        return {
          destinations: result.worktrees.map(describeWorktreeOption),
          baseBranches: serviceBranches ?? buildBaseBranchOptions(result.worktrees),
          hasKnownBranches: serviceBranches ? serviceBranches.length > 2 : hasKnownBranches(result.worktrees),
        };
      },
      onStartAgent: async ({ projectId, worktree, title, description }) => {
        const text = description.trim() || title;
        let result;
        // Paused for exactly this long: the host can report the session it is in the
        // middle of creating to this mount's own live orphan watcher before this very
        // call resolves with its id — before the code below gets a chance to claim it
        // as this task's own link, not a second, unrelated one. See `startingAgents`.
        startingAgents += 1;
        try {
          try {
            result = await host.startSession({
              providerId: EXTENSION_ID,
              id: task.id,
              title: sessionTitleForTask({ title, description }),
              url: taskUrl(task.id),
              text,
              projectId,
              worktree,
              // Not 'open': that asks the host to navigate as part of resolving this
              // very call, which could tear this page down before any of the code
              // below — claiming the session, saving the link — ever runs.
              // `host.openSession` below, called only once everything here is safely
              // saved, is this extension's one and only navigation trigger.
              navigation: 'preserve',
            });
          } catch (error) {
            // OpenChamber's own worktree-creation endpoint can return "Remote branch
            // not found: <name>" here, confirmed in testing to fire even for a branch
            // that genuinely exists on the remote and is already fetched locally — a
            // real OpenChamber bug, not a sign the name is wrong. That real reason
            // doesn't survive the trip through startSession from an extension either;
            // it collapses to a generic failure here, worth reporting upstream with
            // the exact base branch below if it keeps happening.
            if (typeof worktree === 'object' && worktree.kind === 'new' && worktree.baseBranch) {
              throw new Error(
                `Starting the agent failed (${describeHostError(error)}) while basing a new branch on ` +
                `"${worktree.baseBranch}". OpenChamber doesn't pass along its real reason here, only this ` +
                `generic failure — even when the base branch is correct and already fetched. Worth reporting ` +
                `as an OpenChamber bug if it persists.`,
              );
            }
            throw error;
          }
        } finally {
          startingAgents -= 1;
        }
        if (result.sessionId === null) {
          throw new Error(`Could not start the agent (${result.failure}). Its worktree at ${result.directory} was kept so you can recover it by hand.`);
        }
        // A real session now exists and is likely already running. Claim it right
        // away — the one-id-specific guard that protects it from here on, now that
        // the id is actually known, same as `startingAgents` did for the window before it.
        attemptedSessions.add(result.sessionId);
        // Self-healing for whatever gap remains: if some other task already points at
        // this exact session — the race above, caught too late, or a second window —
        // that other task is a duplicate born of it, not a real second task. Removed,
        // not left to confuse the board, with its own title named so it's recognizable.
        const duplicate = tasks.find((t) => t.id !== task.id && t.sessionId === result.sessionId);
        if (duplicate) {
          void deleteTask(host, duplicate.id)
            .then(() => host.toast({ kind: 'info', message: `Removed a duplicate card for the same chat: "${duplicate.title}".` }))
            .catch(() => undefined);
        }
        const updated = applyPatch(task, {
          title,
          description,
          sessionId: result.sessionId,
          projectId,
          status: 'in_progress',
          worktree: resolveTaskWorktree(worktree, result),
        });
        await saveTaskRetrying(updated);
        // Awaited before navigating away — see the matching comment in `onOpenChat`.
        await persistOpenTask(null);
        // The duplicate (if any) is dropped from in-memory state here, not just
        // deleted from storage above — `tasks` was read before that delete settled.
        setTasks(tasks.filter((t) => t.id !== duplicate?.id).map((t) => (t.id === task.id ? updated : t)));
        render();
        // The session was created, but `text` (the description) may not have
        // reached it — `startSession` reports this itself; it is not something
        // retrying from here can fix (there is no "send a message to this
        // session" call), so the best this can do is tell you plainly. The
        // description itself isn't lost: it's still right here on the task.
        const deliveryIssue = describeStartSessionDelivery(result.sent);
        if (deliveryIssue) {
          void host.toast({
            kind: 'error',
            message: `Started the agent, but your description wasn't sent automatically — ${deliveryIssue}. It's still saved on the task; open the chat and paste it in.`,
          }).catch(() => undefined);
        }
        // The explicit navigation, deliberately deferred until everything above is
        // safely saved — see the comment on `navigation: 'preserve'` above.
        await host.openSession(result.sessionId);
        closeDetail();
      },
    });
  };

  const moveTask = async (id: string, status: TaskStatus, beforeId: string | null, visibleColumn: Task[]) => {
    const plan = planDrop(visibleColumn, id, beforeId);
    const current = tasks.find((t) => t.id === id);
    if (!current) return;
    const rebalanceMap = new Map(plan.rebalance.map((entry) => [entry.id, entry.rank]));
    const next = tasks.map((task) => {
      // A manual drag is itself an acknowledgment, same as opening the card.
      if (task.id === id) return applyPatch(task, { status, rank: plan.rank, needsAttentionSince: null });
      const newRank = rebalanceMap.get(task.id);
      return newRank === undefined ? task : applyPatch(task, { rank: newRank });
    });
    setTasks(next);
    render();
    try {
      await saveTask(host, next.find((t) => t.id === id)!);
      await Promise.all(plan.rebalance.map((entry) => saveTask(host, next.find((t) => t.id === entry.id)!)));
    } catch (error) {
      notify(error);
      void reload();
    }
  };

  const updateBadge = () => {
    const openCount = tasks.filter((t) => t.status !== 'done').length;
    void host.setBadge(openCount || null).catch(() => undefined);
  };

  const render = () => {
    columnsRoot.replaceChildren();
    const columns = groupColumns(tasks, filter);
    updateBadge();
    for (const status of STATUSES) {
      const column = el('div', 'kb-column');
      column.dataset.status = status;
      const head = el('div', 'kb-column-head');
      head.append(el('span', 'kb-column-title', STATUS_LABELS[status]));
      head.append(el('span', 'kb-column-count', String(columns[status].length)));
      const body = el('div', 'kb-column-body');
      column.append(head, body);
      if (columns[status].length === 0) body.append(el('div', 'kb-column-empty', 'No tasks'));
      for (const task of columns[status]) body.append(renderCard(task));
      wireDropZone(column, body, status, () => columns[status]);
      columnsRoot.append(column);
    }
  };

  const renderCard = (task: Task) => {
    const card = el('div', task.needsAttentionSince !== null ? 'kb-card kb-card-needs-attention' : 'kb-card');
    card.draggable = true;
    card.dataset.id = task.id;
    const titleRow = el('div', 'kb-row between');
    titleRow.append(el('div', 'kb-card-title', task.title));
    mountButton(titleRow, { label: 'Edit', variant: 'ghost', size: 'xs', onClick: () => openDetail(task.id) });
    card.append(titleRow);
    const meta = el('div', 'kb-card-meta');
    const project = task.projectId ? projects.find((p) => p.id === task.projectId)?.name ?? task.projectId : null;
    if (project) meta.append(el('span', 'kb-muted', project));
    if (task.sessionId) meta.append(el('span', 'kb-mono', `session:${task.sessionId.slice(0, 8)}`));
    card.append(meta);
    if (!task.sessionId) card.append(el('p', 'kb-muted', 'No session yet — click to start an agent or link one.'));
    card.addEventListener('click', (event) => {
      // The Edit button already handled its own click; don't also act on the card underneath it.
      if ((event.target as HTMLElement).closest('button')) return;
      if (task.sessionId) { markReviewed(task); void host.openSession(task.sessionId).catch(notify); return; }
      openDetail(task.id);
    });
    card.addEventListener('dragstart', (event) => {
      draggingId = task.id;
      card.classList.add('kb-dragging');
      event.dataTransfer?.setData('text/plain', task.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => { draggingId = null; card.classList.remove('kb-dragging'); });
    return card;
  };

  const wireDropZone = (column: HTMLElement, body: HTMLElement, status: TaskStatus, visible: () => Task[]) => {
    column.addEventListener('dragover', (event) => {
      if (!draggingId) return;
      event.preventDefault();
      column.classList.add('kb-dragover');
    });
    column.addEventListener('dragleave', (event) => {
      if (event.target === column) column.classList.remove('kb-dragover');
    });
    column.addEventListener('drop', (event) => {
      event.preventDefault();
      column.classList.remove('kb-dragover');
      const id = draggingId ?? event.dataTransfer?.getData('text/plain') ?? null;
      draggingId = null;
      if (!id) return;
      const rects = [...body.querySelectorAll<HTMLElement>('.kb-card')]
        .filter((node) => node.dataset.id !== id)
        .map((node) => ({ id: node.dataset.id!, ...node.getBoundingClientRect() }));
      const beforeId = insertionTarget(rects, event.clientY);
      void moveTask(id, status, beforeId, visible());
    });
  };

  /**
   * Deletions and archives usually happen in the sidebar while this board is
   * closed, where no live watcher is running — so link health is re-checked
   * freshly on every load, not only live. For each project holding linked
   * tasks, fetches the current sessions and worktrees once, and clears
   * every link that provably no longer resolves. Incomplete or failed
   * fetches clear nothing — same "unknown is not gone" rule the live
   * watchers follow.
   */
  const reconcileLinks = async () => {
    const byProject = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.projectId) continue;
      if (!task.sessionId && !task.worktree) continue;
      const list = byProject.get(task.projectId) ?? [];
      list.push(task);
      byProject.set(task.projectId, list);
    }
    if (byProject.size === 0) return;
    const results = await Promise.allSettled([...byProject.keys()].map(async (projectId) => {
      const [sessions, worktrees] = await Promise.all([fetchSessions(host, projectId), fetchWorktrees(host, projectId)]);
      return { projectId, sessions, worktrees };
    }));
    if (disposed) return;
    let cleared = 0;
    let deleted = 0;
    for (const result of results) {
      if (disposed) return;
      if (result.status !== 'fulfilled') continue;
      const { projectId, sessions, worktrees } = result.value;
      // The full session list distinguishes archived sessions from deleted ones;
      // `complete` false means the list can't be trusted — and real `coverage`
      // is what lets a missing session count as deleted rather than unknown.
      const sessionsView: SessionsView = { state: sessions.complete ? 'ready' : 'error', coverage: sessions.coverage, sessions: sessions.allSessions };
      const worktreesView: WorktreesView = { state: worktrees.complete ? 'ready' : 'error', worktrees: worktrees.worktrees };
      for (const task of byProject.get(projectId) ?? []) {
        // Re-read from `tasks` — a live watcher may have unlinked this task while the fetches were in flight.
        const current = tasks.find((t) => t.id === task.id);
        if (!current || current.projectId !== projectId) continue;
        if (current.sessionId) {
          const sessionState = sessionLinkState(current.sessionId, null, sessionsView);
          if (sessionState === 'deleted') {
            if (deleteTaskForGoneSession(current.id, null)) deleted += 1;
          } else if (sessionState === 'archived') {
            if (clearTaskLink(current.id, { sessionId: null }, null)) cleared += 1;
          }
        }
        if (current.worktree && worktreeLinkState(current.worktree.directory, worktreesView) === 'gone') {
          if (clearTaskLink(current.id, { worktree: null }, null)) cleared += 1;
        }
      }
    }
    if (cleared > 0 || deleted > 0) {
      const parts = [];
      if (deleted > 0) parts.push(`deleted ${deleted} task${deleted === 1 ? '' : 's'}`);
      if (cleared > 0) parts.push(`cleared ${cleared} stale link${cleared === 1 ? '' : 's'}`);
      void host.toast({ kind: 'info', message: `${parts.join(' and ')} — the session or worktree behind ${parts.length === 1 && deleted > 0 ? 'it' : 'them'} no longer exists.` }).catch(() => undefined);
    }
  };

  const reload = async () => {
    refresh.update({ loading: true });
    try {
      const [{ tasks: loaded, failedKeys }, loadedPrefs, watermark, dismissed] = await Promise.all([
        loadTasks(host), loadPrefs(host), loadOrphanWatermark(host), loadDismissedSessions(host),
      ]);
      // A manual/initial reload is a clean slate for the retry guards above.
      attemptedSessions = new Set();
      lastAttemptedStatus = new Map();
      dismissedSessionIds = dismissed;
      if (watermark === null) {
        // First time this feature has ever run: nothing that already exists right now is "going forward".
        orphanWatermark = Date.now();
        void saveOrphanWatermark(host, orphanWatermark).catch(() => undefined);
      } else {
        orphanWatermark = watermark;
      }
      setTasks(loaded);
      prefs = loadedPrefs;
      filter = { projectId: prefs.projectId, query: prefs.query };
      projectSelect.update({ value: filter.projectId, options: projectOptions() });
      searchField.update({ value: filter.query });
      if (failedKeys.length) showBanner('Some tasks could not be loaded', `${failedKeys.length} record(s) were skipped. Other tasks are safe; Refresh retries.`, 'warning');
      else clearBanner();
      render();
      // Stale links (a session or worktree deleted while this board was closed)
      // are cleared before the orphan watcher starts, so a session whose link
      // is about to be dropped can never also be re-adopted as a duplicate.
      await reconcileLinks();
      if (prefs.openTaskId && tasks.some((t) => t.id === prefs.openTaskId)) openDetail(prefs.openTaskId);
    } catch (error) { notify(error); }
    finally { refresh.update({ loading: false }); }
  };

  let stopProjects: (() => void) | null = null;
  void watchProjects(host, (state) => {
    if (disposed) return;
    if (state.state === 'error') { showBanner('Projects unavailable', 'Showing tasks without live project data.', 'warning'); return; }
    projects = state.projects;
    projectSelect.update({ options: projectOptions() });
    render();
  }).then((stop) => { if (disposed) stop(); else stopProjects = stop; }, (error) => { if (!disposed) notify(error); });

  const spinner = mountSpinner(spinnerSlot, { label: 'Loading board…' });
  void reload().finally(() => {
    spinner.dispose(); spinnerSlot.hidden = true;
    // Wait for the first load so a session already linked to a persisted task is never mistaken for an orphan.
    if (!disposed) {
      orphanWatcher = watchOrphanSessions(
        host,
        excludedSessionIds,
        (found) => adoptRunningSession(found.projectId, found.session, found.status),
        SYNC_OPTIONS,
        (error) => {
          if (!disposed) showBanner('Session auto-discovery degraded', `${describeHostError(error)} Sessions started outside this board may not be picked up automatically meanwhile.`, 'warning');
        },
      );
    }
  });

  return {
    dispose: () => {
      disposed = true;
      stopProjects?.();
      sessionSync.dispose();
      worktreeSync.dispose();
      orphanWatcher?.dispose();
      detail?.dispose();
    },
  };
};
