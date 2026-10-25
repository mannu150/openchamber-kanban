/**
 * The host allows at most 32 active workspace + shell subscriptions per iframe.
 * The kanban board keeps 2 of them permanently (its own onProjects plus the
 * orphan-session watcher's onProjects), so live per-project subscriptions
 * (sessionSync / worktreeSync) must share the rest. Going over the cap gets
 * every later registration rejected, which used to break unrelated features.
 * That is why the limit is 30, not 32.
 */
export const LIVE_SYNC_SUBSCRIPTION_LIMIT = 30;

let active = 0;

export type SubscriptionCapError = Error & { code: 'SUBSCRIPTION_LIMIT' };

/** Returns a SUBSCRIPTION_LIMIT error instead of subscribing when the budget is spent. */
export function acquireLiveSyncSubscription(): SubscriptionCapError | null {
  if (active >= LIVE_SYNC_SUBSCRIPTION_LIMIT) {
    const error = new Error('live sync subscription limit reached') as SubscriptionCapError;
    error.code = 'SUBSCRIPTION_LIMIT';
    return error;
  }
  active += 1;
  return null;
}

/** Releases a slot. Unsubscribe is idempotent on the host side; this must be too. */
export function releaseLiveSyncSubscription(): void {
  active = Math.max(0, active - 1);
}

export function liveSyncSubscriptionsActive(): number {
  return active;
}

/** Test isolation: each iframe is one JS realm, so a module-level counter is correct. */
export function resetLiveSyncBudgetForTest(): void {
  active = 0;
}
