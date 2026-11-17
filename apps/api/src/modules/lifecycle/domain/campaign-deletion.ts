// Campaign deletion run (ARCHITECTURE §5.8, SB-D12, SB-D17): the step table and the pure rules of the run. No framework.

export const CAMPAIGN_DELETION_QUEUE = 'lifecycle.campaign-deletion';

/** The four steps of a campaign run (`deletion_runs.step` 1..4). Step 0, the erasure ledger object, runs before step 1. */
export const STEP_PROVIDER_TASKS = 1;
export const STEP_MEDIA = 2;
export const STEP_VERIFY = 3;
export const STEP_HARD_DELETE = 4;
export const LAST_STEP = STEP_HARD_DELETE;

export type RunState = 'running' | 'completed' | 'stuck';

export interface DeletionRun {
  readonly id: string;
  readonly kind: 'campaign' | 'account';
  readonly subjectId: string;
  readonly ownerId: string;
  readonly step: number;
  readonly state: RunState;
  readonly attempts: number;
  readonly remainingObjects: number | null;
  readonly lastErrorClass: string | null;
  readonly notBefore: string;
  readonly createdAt: string;
}

/** The object key of the write-once ledger entry: `erasure/{timestamp}-{runId}` (IDs and kind only). */
export function ledgerKeyOf(createdAt: string, runId: string): string {
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  return `erasure/${stamp}-${runId}`;
}

/** The body of a ledger object: no email, no content. */
export function ledgerBodyOf(run: Pick<DeletionRun, 'id' | 'kind' | 'subjectId'>): string {
  return JSON.stringify({ runId: run.id, kind: run.kind, subjectId: run.subjectId });
}

/**
 * How long the run waits after the cancel before it counts what is left: the longest a job of the campaign can still
 * run (its deadline) plus the grace for a copy that was already past its last check. A copy in flight writes no object
 * after `deleting` (it checks, puts, checks again and removes its own object), so this wait only closes the window.
 */
export function verifyDelayMs(deadlineMinutes: number, graceSeconds: number): number {
  return (deadlineMinutes * 60 + graceSeconds) * 1000;
}

/** A failure counted against the run: stuck once the limit is reached, otherwise retried by the queue's backoff. */
export function nextOnFailure(attempts: number, limit: number): { attempts: number; stuck: boolean } {
  const next = attempts + 1;
  return { attempts: next, stuck: next >= limit };
}

/** A short stable class for `last_error_class`; never a message, never a key or an ID. */
export function errorClassOf(error: unknown): string {
  const name = error instanceof Error && error.name !== '' ? error.name : 'Error';
  return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'Error';
}
