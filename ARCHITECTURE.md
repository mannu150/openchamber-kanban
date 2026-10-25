# Architecture

A local-first Kanban board extension for OpenChamber, built with the official `@openchamber/sdk`. All task and preference data lives in `host.storage` on the connected OpenChamber server — nothing is sent anywhere else, and no capability beyond what's listed below is used.

Requires OpenChamber `>=1.24.0` — the Extensions SDK (`Settings → Extensions`, panels, pages, `host.storage`) doesn't exist in earlier versions.

## Manifest and capabilities

```jsonc
{
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=1.24.0" },
    "contributes": {
      "panel": { "id": "kanban-board", "name": "Kanban", "icon": "task", "entry": "panel/index.html" },
      "page": { "entry": "panel/page.html", "title": "Kanban board" },
      "capabilities": ["sessions", "prompt"],
      "service": { "entry": "service/main.js", "runtime": "host", "permissions": { "exec": ["git"] } }
    }
  }
}
```

| Capability | Used for |
|---|---|
| `sessions` | `listProjects`/`onProjects`, `listSessions`/`onSessions`, `listWorktrees`/`onWorktrees`, `startSession`, `openSession` — reading project/session/worktree state and creating or opening sessions. |
| `prompt` | Permits `startSession` to send its `text` field as the agent's first message. The returned `sent` value is checked because session creation can succeed without the message being delivered. |
| `service` (auto-added by declaring `contributes.service`) | The local git-branch-reading service, see below. |

**Capability approval is all-or-nothing.** The host's own grant endpoint (`PUT /api/guests/:id/capabilities`) accepts only the full requested list or `[]` — there is no partial grant. Installing this extension means accepting all three capabilities together; there is no way to get the Kanban board without also being asked about the local service.

## File structure

```
openchamber-kanban/
  package.json
  src/
    domain/
      task.ts          # Task type, validation, createTask/applyPatch/parseTask — pure, no host
      board.ts          # column grouping, filtering, drag-and-drop rank math, Review sort — pure
      sync.ts            # agent activity → task status mapping — pure
      worktree.ts         # worktree/branch picker logic, local service response parsing — pure
      unlink.ts            # link health: whether a linked session/worktree provably still exists — pure
      autoTask.ts          # orphan-session eligibility + initial status + title — pure
    store/
      taskStore.ts      # one host.storage key per task: task:<id>
      prefs.ts            # board filters + last-open task: host.storage key "prefs"
      orphanWatermark.ts    # "going forward" cutoff timestamp: host.storage key "orphan-watermark"
    host/
      workspace.ts      # host.listSessions/listWorktrees/onProjects wrappers — reads never touch the subscription cap
      subscriptionBudget.ts  # shared cap on live per-project subscriptions (see "Subscription budget")
      sessionSync.ts      # live onSessions watcher → status sync + deleted/archived session unlink (budget-gated, listSessions fallback)
      worktreeSync.ts       # live onWorktrees watcher → worktree-deleted unlinks (budget-gated, listWorktrees fallback)
      orphanSessions.ts     # one onProjects subscription + periodic listSessions sweeps → sessions with no task yet
      branchService.ts        # calls the local git-branch service; null on any failure
    ui/
      dnd.ts            # drop-target math — pure, no DOM
      styles.ts           # CSS using the host's --oc-* theme tokens
      dom.ts                # element() helper
      board.ts               # the Kanban board
      detail.ts                # task detail dialog
    page.ts             # full-screen page entry (contributes.page)
    panel.ts              # rail panel entry: summary + badge
    service/
      main.ts           # local git-branch service source (Node, not browser)
  panel/
    index.html, page.html   # HTML shells
    main.js, page.js          # esbuild IIFE output
  service/
    main.js             # esbuild Node/ESM output of src/service/main.ts
  test/                 # node:test unit tests for domain/, store/, host/
  scripts/build.mjs      # esbuild: browser IIFE for panel/page, Node/ESM for the service
```

Layering: `domain/` has no SDK or DOM imports — pure functions, fully unit-tested. `store/` and `host/` depend only on narrow `Pick<HostClient, …>` slices, tested with in-memory fakes. `ui/` is the only layer that touches the DOM.

## Task data model

```ts
type Task = {
  schemaVersion: 1;
  id: string;                 // t_<base36 time><6 random chars>
  title: string;
  description: string;        // first message requested for the agent; delivery is checked via result.sent
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
  rank: number;                // fractional, for drag-and-drop ordering within a column
  projectId: string | null;
  sourceBranch: string | null;  // unused by current UI; kept for backward compatibility with old records
  worktree: { directory: string; branch: string | null } | null;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  needsAttentionSince: number | null;  // set when the Review marker/sort should treat this as unseen
};
```

Stored one task per `host.storage` key (`task:<id>`), so editing one task can never corrupt another, and a malformed record is reported and skipped rather than blocking the rest of the board. Board filters, the currently-open task, and the "going forward" orphan-adoption cutoff are each a separate key (`prefs`, `orphan-watermark`).

## The board

Full-screen page (`contributes.page`) with a project filter, a search field, and five columns (Backlog, To Do, In Progress, Review, Done). The rail panel is a lightweight read-only summary (open-task count + badge) — the full board can only be opened from the sidebar's Extension pages menu, never from the extension itself.

- **Add task** is a single button. A click creates a real, persisted task immediately (title `"New task"`, appended to Backlog) and opens its detail popup for editing — no separate title field in the toolbar.
- **Drag-and-drop** uses fractional ranks (`rankAtEnd`, `planDrop`), so moving a card only ever rewrites that card and, rarely, a few neighbors whose gap became too small — never the whole column.
- **Every column has a "Move to" button** in the detail popup, one per status except the task's current one, alongside dragging.
- **The Review column sorts by urgency**, not rank: whichever task most recently needs attention leads; already-seen tasks sink below and keep normal rank order among themselves. Every other column stays rank-ordered.

### The "needs attention" marker

A task that lands in Review through something other than your own action — the live agent-status sync or auto-adopting a running session — gets `needsAttentionSince` set to that moment, shown as a warning-colored left border on its card. It's cleared the moment you open the task (its chat, or its detail popup) or drag it anywhere yourself. A status change you make deliberately (dragging, or the detail popup's own "Move to Review") never sets the marker — only the two automatic paths do.

## Subscription budget

The host allows at most 32 active workspace + shell subscriptions per iframe, and everything in this board's page shares that one cap. This board holds 2 of them permanently (its own `onProjects` plus the orphan watcher's `onProjects`), and `src/host/subscriptionBudget.ts` caps the per-project live watches (`sessionSync`, `worktreeSync`) at the remaining 30. Once the budget is spent, further projects are not subscribed live: a warning banner says so, and the affected project keeps syncing through periodic one-off `listSessions`/`listWorktrees` reads (~15s, sequential; they never touch the cap) until a later `sync()` lands a freed slot. A fallback pass never overlaps itself — a tick that arrives during a slow read is skipped — and a failing read is reported once per project until a read succeeds again; the timer stops as soon as the last fallback project is live again. A slot is returned only after the real unsubscribe happened — a watch still pending registration keeps its slot until it settles — and a refused registration returns its slot so a later `sync()`/`Refresh` retries. `sync()` tears down unneeded watches before acquiring new ones, so a slot freed by one project is reusable by another within the same pass. Historically, boards on hosts with ~32+ registered projects exhausted the cap through the orphan watcher's per-project subscriptions, which then made even one-off list loads fail anywhere in the page.

## Agent-status sync

Implemented in `src/domain/sync.ts` (`statusForSession`, pure) and watched live by `src/host/sessionSync.ts` (`createSessionSync`, one `host.onSessions` subscription per project among currently-linked tasks, taken from the shared budget described under "Subscription budget" below — beyond the budget a project falls back to periodic `listSessions` reads and a warning says so):

| Session activity / outcome | Task moves to |
|---|---|
| `running`, `retrying` | In Progress (from any status except Done) |
| `waiting-question` | Review |
| `waiting-permission` | Review |
| `idle` + outcome `completed` | Review |
| `idle` + outcome `failed` | Review |
| anything else | no change |

A task marked **Done is never moved** by this — only your own "Mark Done" ever sets it. A save failure here doesn't retry on every subsequent snapshot (a live session's `onSessions` snapshot fires continuously while it runs): `lastAttemptedStatus` tracks the status this mount last attempted for a task, and only a genuinely different target status is retried, cleared on `Refresh`/reopen.

## Automatic unlinking

A task's links must not outlive what they point at. When a session is deleted, the linked task is deleted automatically. When a session is archived, or a worktree is deleted (all from OpenChamber's sidebar), the corresponding link is cleared from the task automatically — `sessionId` for a session, `worktree` for a worktree. The task itself is kept for archive/worktree cases, with its title, column, and description untouched; it simply becomes a plain unstarted card again, so **Start Agent** or **Link an existing session** can be used on it fresh. The status is deliberately left alone too — moving or archiving a card's session is not a status change.

Two mechanisms cover it, because a page-type extension only runs while it is the selected view:

- **Live** — `src/host/sessionSync.ts` reports a deleted or archived session on its existing `onSessions` subscription (no extra subscription); `src/host/worktreeSync.ts` does the same for worktrees via one `onWorktrees` subscription per project holding worktree-linked tasks. `src/domain/unlink.ts` (`sessionLinkState`, `worktreeLinkState`) decides: an archived session (`archivedAt`) is archived; an absent one is deleted only when the snapshot finished loading (`state: 'ready'`) and, for the directory the session was last seen in, the per-directory `coverage` finished too. Anything less is `unknown`, and **unknown never deletes** — an incomplete list is not a disappearance, and a false "gone" would lose the task permanently.
- **On every load** — `reconcileLinks` in `src/ui/board.ts` runs at the end of every `reload()`, before the orphan watcher starts: for each project holding linked tasks it fetches the current sessions and worktrees once (`fetchSessions`, which returns both active and full top-level session lists plus per-directory `coverage`, and `fetchWorktrees` — both plain `host.listSessions`/`host.listWorktrees` reads that never count against the subscription cap) and deletes tasks or clears links that provably no longer resolve. This is what catches the common case — deleting or archiving in the sidebar while the board is closed, where no live watcher was running. It runs before orphan adoption starts so a session whose stale task is being deleted can never also be re-adopted as a duplicate task.

Unlinking shows a toast naming the task. On a load-time pass it is one summary toast instead of one per task. A save failure falls back to a full reload, which re-loads the still-linked task and lets the next pass retry.

## Auto-adopting a session with no task

A session with no task pointed at it, created at or after a persisted watermark timestamp, becomes a new task automatically — In Progress while running, Review once it needs attention (question, permission prompt, finished, or failed) — using the same `statusForSession`-derived mapping (`initialStatusForNewSession` in `src/domain/autoTask.ts`), linked to that session, titled from the session's own title (or `"New session in <project>"`/`"New session (<short id>)"` when the host's own id-as-title fallback would otherwise show a raw session id).

- `src/host/orphanSessions.ts` (`watchOrphanSessions`) sweeps rather than subscribes: one `onProjects` registration for the project list, then a periodic bounded-parallelism pass of one-off `host.listSessions` reads over every registered project (re-run whenever the project list changes), reporting every structurally-adoptable session (not a subagent, not archived, not already linked) with a resolvable status, on every sweep. Sidebar-created sessions are therefore adopted while the board is open and are also found on the next board load if they were created while it was closed. The reason it doesn't hold one `onSessions` subscription per project is the subscription budget above: with ~32+ registered projects that alone would exhaust the host's per-frame cap and break unrelated features. Read failures surface as one bounded warning whenever the failure count changes (`N of M projects unreadable`), so an unreachable project stays visible without per-sweep or per-project spam, and a project removed from the list mid-sweep never adopts from its stale in-flight read. Repeated reports of the same session across sweeps are deduped by `attemptedSessions`.
- `src/store/orphanWatermark.ts` holds the single cutoff: set once, the first time this feature ever runs, to that moment, and never moved again. Every session's real `createdAt` is compared against it on every board load — this is the only design that works for a page-type extension, since a page only runs while it's the selected main view, and detection cannot happen while you're in a different chat.
- `attemptedSessions` in `board.ts` guards against retrying a failed adoption on every snapshot tick, cleared on `Refresh`/reopen.
- `startingAgents` temporarily pauses adoption while a task's `startSession` request is in flight. The host can publish the new session before that request returns its id; once returned, the id is claimed and the originating task is saved with the link before navigation. A final same-session check removes any duplicate card already linked to that session.
- Subagents and archived sessions are never adopted. A toast announces each adoption.

## Start Agent

Shown in the task detail popup until a session is linked (after that, Open Chat/Unlink instead). Requires a title, description, and project; disabled with an inline reason otherwise, re-evaluated live.

**Start from** is a radio choice:
- **Project root** — run directly in the main checkout, no worktree.
- **New branch** — a fresh branch and worktree, based on the branch picked in **Based on**. Shows **Branch name** and a read-only **Folder name** that always mirrors it: `startSession`'s `{ kind: 'new', name, baseBranch }` has one `name` for both, with no way to set a folder name independently.
- **Existing worktree** — reuse a worktree already checked out (`listWorktrees`). Not the same as "check out any branch that doesn't have a worktree yet" — the SDK has no such mode, only `{ kind: 'existing', directory }` for a worktree that already exists on disk.

**Based on** is a searchable dropdown (`searchable: true`), populated from the local git-branch service when available, or the project's existing worktree branches plus "Use project default" otherwise. A new branch can't be based on itself (`branchNameConflictsWithBase`) — checked before the request is ever sent.

Clicking **Start Agent**:
1. Passes the title, description, and project currently shown in the dialog, including edits not yet saved with **Save changes**. The description becomes `text`; the current values are also saved to the task as part of the session-link update.
2. The session title uses the task title. If the title is still the default `"New task"`, `sessionTitleForTask` uses the first line of the description instead. This avoids giving a new session the generic task placeholder as its name.
3. Builds the `worktree` value (`buildSessionWorktree`) and calls `host.startSession` with `navigation: 'preserve'`. Adoption is paused during that request because the host can publish the new session before the request returns its id.
4. When a session id returns, it is claimed in `attemptedSessions`, and the existing task is saved with that id, the latest title and description, the project, In Progress status, and its worktree. The save retries three times with backoff (`saveTaskRetrying`). A same-session check removes an already-created duplicate task if one exists.
5. Checks `result.sent`. If the session was created but the description was not sent (`no-model`, `skipped`, or `failed`), the board shows an error toast. The description remains saved on the task; the SDK has no call to send a message to an arbitrary existing session afterward.
6. Clears the saved open-task preference and waits for that storage write to finish before calling `host.openSession(result.sessionId)`. The dialog therefore does not reopen when the user returns to the board.
7. On failure (`sessionId: null`), surfaces the host's own failure reason and keeps the worktree's directory in the message rather than deleting anything.

## The local git-branch service

Declared via `contributes.service` with `permissions.exec: ["git"]` — the only way to list a repository's real branches, since the SDK itself has no API for this (confirmed by enumerating every `HostClient` method).

- `src/service/main.ts`, built to `service/main.js` (Node/ESM target, not the browser build) — a small HTTP server the host spawns and proxies to on `127.0.0.1`. Every request is bearer-authenticated by the host itself; the panel never sees the token or dials the port directly.
- Runs **exactly one command**: `git -C <directory> for-each-ref --sort=-committerdate --count=200 --format=%(refname) refs/heads refs/remotes` — read-only, most-recently-active branches first, capped at 200, for a project directory the panel already knows about (`path.isAbsolute` checked).
- `src/host/branchService.ts` (`fetchServiceBranches`) is best-effort: not approved, not running, a bad answer, or any other error all become `null`, never an exception the UI has to handle, because the worktree-derived fallback is a complete, working option on its own.

## Known SDK limitations

- **No API to list a repository's full branch set**, only `GuestWorktree.branch` per existing worktree, or the local service above.
- **Capability approval is all-or-nothing** across the whole manifest (see above) — there's also no cross-extension service API, so a capability can't be split into its own, separately-optional package either.
- **Chats are invisible.** A chat (a session with no project) is explicitly documented as outside any project; the `sessions` capability's methods are all scoped to registered projects. There is no SDK method to list or watch chats at all.
- **Session auto-adoption runs only while the Kanban page is active**, plus the next time it opens. A session started from the sidebar while the board is active is adopted live; one started while the board is closed is found when the board opens again, if it meets the watermark and activity rules. A session started from a task is linked directly to its existing task instead of being adopted as another task.
- **No way to set a worktree's folder name independently of its branch name** — `startSession`'s `{ kind: 'new', name }` sets both together.
- **OpenChamber's own worktree-creation can fail with "Remote branch not found" for a branch confirmed to exist on the remote and already fetched locally.** When `host.startSession` rejects for a new-branch request, the real reason doesn't survive the trip back to the extension — only a generic failure does — so the error shown names the base branch involved and suggests this is a known possibility, not a claim that the branch name is wrong.

## Install and verify

```bash
git clone <this repository>
cd openchamber-kanban
npm install
npm run check   # typecheck + unit tests + build panel/main.js, panel/page.js, service/main.js
```

In OpenChamber: **Settings → Extensions → Add** → paste this folder's absolute path → approve `sessions`, `prompt`, and the local service → open **Kanban** from the Extension pages menu above the session list.

Acceptance scenarios:

1. Create three tasks, reload OpenChamber → all three persist.
2. Drag a task between columns, reload → the new status persists.
3. Link an existing session to a task → **Open Chat** → the real session opens via `host.openSession`.
4. Edit a task title and description without clicking **Save changes**, then start an agent → the current values are saved, the description is sent when OpenChamber reports success, the same task links to the session, and the task moves to In Progress.
5. Run two tasks concurrently → they never share a session id.
6. An agent finishes a turn → the task moves to Review, never to Done, until marked Done by hand.
7. Start a session from the OpenChamber sidebar → one new task appears for it, in the column its activity implies.
8. Start an agent from a task → only the originating task is linked to that session; no second task is adopted for the same session.
