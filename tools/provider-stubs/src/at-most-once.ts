// Reference at-most-once submit of ARCHITECTURE §5.5, used by the integration tests to prove the
// restart point between "provider accepted" and "task ID written". It is a model of the rule
// ("submit is called at most once per job row; no retry; an orphan becomes outcome_unknown"),
// not product code.

export type JobState = 'pending' | 'submitting' | 'submitted' | 'failed';

export interface JobRow {
  id: string;
  state: JobState;
  providerTaskId: string | null;
  failure: 'outcome_unknown' | 'configuration' | 'credit' | 'temporary' | null;
  callCount: number;
}

export class JobStore {
  readonly rows = new Map<string, JobRow>();

  create(id: string): JobRow {
    const row: JobRow = { id, state: 'pending', providerTaskId: null, failure: null, callCount: 0 };
    this.rows.set(id, row);
    return row;
  }

  // Conditional update: only a pending row may be claimed, exactly once.
  claim(id: string): boolean {
    const row = this.rows.get(id);
    if (!row || row.state !== 'pending') return false;
    row.state = 'submitting';
    row.callCount += 1;
    return true;
  }

  // Sweep: a row stuck in `submitting` without a task ID becomes outcome_unknown (never resubmitted).
  sweepOrphans(): number {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.state === 'submitting' && row.providerTaskId === null) {
        row.state = 'failed';
        row.failure = 'outcome_unknown';
        n += 1;
      }
    }
    return n;
  }
}

export class SimulatedCrash extends Error {}

export interface SubmitDeps {
  store: JobStore;
  baseUrl: string;
  apiKey: string;
  model: string;
  // called after the provider answered, before the task ID is written (the restart point)
  beforeWriteTaskId?: () => void;
}

export async function submitOnce(jobId: string, deps: SubmitDeps): Promise<JobRow> {
  const row = deps.store.rows.get(jobId);
  if (!row) throw new Error(`unknown job ${jobId}`);
  if (!deps.store.claim(jobId)) return row;
  let response: Response;
  try {
    response = await fetch(`${deps.baseUrl}/api/v3/${deps.model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'stub' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // connection died or timed out after send: the outcome is unknown, never retried
    row.state = 'failed';
    row.failure = 'outcome_unknown';
    return row;
  }
  if (response.status >= 500) {
    row.state = 'failed';
    row.failure = 'outcome_unknown';
    return row;
  }
  if (response.status === 429 || response.status === 400 || response.status === 401) {
    row.state = 'failed';
    row.failure = response.status === 429 ? 'temporary' : 'configuration';
    return row;
  }
  const body = (await response.json()) as { data: { id: string } };
  deps.beforeWriteTaskId?.();
  row.providerTaskId = body.data.id;
  row.state = 'submitted';
  return row;
}
