import { HostRequestError, type GuestDirectoryCoverage, type GuestProject, type GuestSessionRecord, type GuestSessionsSnapshot, type GuestWorktree, type GuestWorktreesSnapshot, type HostClient, type StartSessionSent } from '@openchamber/sdk';

export type WorkspaceHost = Pick<HostClient, 'onProjects' | 'listSessions' | 'listWorktrees'>;

export type ProjectsState = { state: 'loading' | 'ready' | 'error'; projects: GuestProject[] };

/** Live project list from OpenChamber. Returns an unsubscribe function. */
export const watchProjects = async (host: WorkspaceHost, listener: (state: ProjectsState) => void) =>
  host.onProjects((snapshot) => listener({ state: snapshot.state, projects: snapshot.projects }));

export type SessionsResult = { complete: boolean; coverage: GuestDirectoryCoverage[]; sessions: GuestSessionRecord[]; allSessions: GuestSessionRecord[] };

const SETTLE_RETRY_MS = 500;

/**
 * Reads via `listSessions`/`listWorktrees` instead of a throwaway
 * subscription: a read never counts against the 32-subscriptions-per-frame
 * cap, so one feature's live watchers can no longer starve another's list
 * loads. A read may land while the host store is still `loading`; retries
 * cheaply until it settles or the deadline passes, then hands back whatever
 * it has — callers treat incomplete data as "unknown", never as empty.
 */
const readUntilSettled = async <T extends { state: 'loading' | 'ready' | 'error' }>(read: () => Promise<T>, timeoutMs: number): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await read();
    if (snapshot.state !== 'loading' || Date.now() >= deadline) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_MS));
  }
};

export const fetchSessions = async (host: WorkspaceHost, projectId: string, timeoutMs = 8000): Promise<SessionsResult> => {
  const snapshot: GuestSessionsSnapshot = await readUntilSettled(() => host.listSessions(projectId), timeoutMs);
  const allSessions = snapshot.sessions
    .filter((session) => session.parentId === null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const sessions = allSessions.filter((session) => session.archivedAt === null);
  return { complete: snapshot.state === 'ready', coverage: snapshot.coverage, sessions, allSessions };
};

export type WorktreesResult = { complete: boolean; worktrees: GuestWorktree[] };


export const fetchWorktrees = async (host: WorkspaceHost, projectId: string, timeoutMs = 8000): Promise<WorktreesResult> => {
  const snapshot: GuestWorktreesSnapshot = await readUntilSettled(() => host.listWorktrees(projectId), timeoutMs);
  return { complete: snapshot.state === 'ready', worktrees: snapshot.worktrees };
};


export const projectForDirectory = (projects: readonly GuestProject[], directory: string | null) => {
  if (!directory) return null;
  const exact = projects.find((project) => project.directory === directory);
  if (exact) return exact;
  return projects
    .filter((project) => directory.startsWith(`${project.directory}/`))
    .sort((a, b) => b.directory.length - a.directory.length)[0] ?? null;
};

export const describeHostError = (error: unknown) => {
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case 'NOT_GRANTED': return 'This needs the "sessions" permission. Approve it in Settings → Extensions.';
      case 'DISABLED': return 'The extension is paused in Settings → Extensions.';
      case 'HOST_UNAVAILABLE': return 'Not running inside OpenChamber.';
      case 'HOST_TIMEOUT': return 'OpenChamber did not answer in time. Try again.';
      case 'NOT_FOUND': return 'That session no longer exists.';
      default: return `${error.code}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * Why `startSession`'s `text` (the task's description) might not have
 * reached the agent as its first message, even though the session itself
 * was created successfully. `null` means it was sent — nothing to tell the
 * user. The description stays safe on the task either way; it's not lost,
 * only not delivered automatically.
 */
export const describeStartSessionDelivery = (sent: StartSessionSent): string | null => {
  switch (sent) {
    case 'sent': return null;
    case 'no-model': return 'no model is configured for this session';
    case 'skipped': return "OpenChamber skipped sending it — the session may be waiting on something else first (check the chat)";
    case 'failed': return 'OpenChamber reported the send itself failed';
  }
};
