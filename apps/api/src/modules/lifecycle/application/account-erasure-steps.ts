// Account erasure run (ARCHITECTURE §5.8, SB-D12): the step table. Step 0, the erasure ledger object, runs before step 1.

export const ACCOUNT_ERASURE_QUEUE = 'lifecycle.account-erasure';

export const ACCOUNT_STEP_REVOKE_SESSIONS = 1;
export const ACCOUNT_STEP_DELETE_IDP_USER = 2;
export const ACCOUNT_STEP_PURGE_STORAGE = 3;
export const ACCOUNT_STEP_VERIFY = 4;
export const ACCOUNT_STEP_HARD_DELETE = 5;

/** The two key prefixes of an owner: uploads and generated media under `u/`, sanitize quarantine under `q/`. */
export function accountPrefixes(userId: string): readonly string[] {
  return [`u/${userId}/`, `q/${userId}/`];
}

/** The write-once ledger entry of a run (IDs and kind only, no email): `erasure/{timestamp}-{runId}`. */
export function ledgerKeyAndBody(run: { createdAt: string; id: string; subjectId: string }): {
  key: string;
  body: string;
} {
  const stamp = new Date(run.createdAt).toISOString().replace(/[:.]/g, '-');
  return {
    key: `erasure/${stamp}-${run.id}`,
    body: JSON.stringify({ runId: run.id, kind: 'account', subjectId: run.subjectId }),
  };
}

/** The wait a removal adds before the first step: `ERASURE_HOLD_PERIOD_HOURS`. */
export function holdMs(hours: number): number {
  return hours * 3_600_000;
}
