import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../db/index.js';
import type { DbTx } from '../db/index.js';
import { createTestDatabase } from '../db/test-database.js';
import type { TestDatabase } from '../db/test-database.js';
import { submitOnce, submitOrphanHook, sweepSubmitOrphans } from './at-most-once.js';
import type { SubmitResult, TxScope } from './at-most-once.js';
import { RUN_LIMIT, claimWithUserLimit, jobTable } from './claim.js';
import { POLL_QUEUE, expireOverdue, pollRearmHook, runPoll, schedulePoll } from './poll.js';
import type { PollResult } from './poll.js';
import { DuplicateSweepHookError, SweepRegistry } from './sweep-registry.js';

// TASK-029 over a fake provider-job table on the shared test PostgreSQL: the claim, the at-most-once submit, the
// poll lease and the sweep hooks are provider-agnostic, so no provider is involved (TC-CLP-03, TC-CLP-06, TC-PCA-01..03).

let database: TestDatabase;
let pool: pg.Pool;
let uow: UnitOfWork;
const jobs = jobTable('fake_jobs');
const timing = { intervalSec: 5, leaseSec: 60 };

beforeAll(async () => {
  database = await createTestDatabase({ label: 'task029', migrations: false });
  pool = new pg.Pool({ connectionString: database.url, max: 16 });
  await pool.query(`create table fake_jobs (
    id uuid primary key default gen_random_uuid(), owner_id uuid not null, state text not null default 'pending',
    cause_class text, cause_message text, reuse_hash text, key_id uuid, key_version int, submitting_at timestamptz,
    provider_task_id text, next_poll_at timestamptz, deadline_at timestamptz, provider_completed_at timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  uow = new UnitOfWork(drizzle(pool));
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

async function insert(
  state = 'pending',
  extra: Record<string, string | null> = {},
  owner: string = randomUUID(),
): Promise<{ id: string; owner: string }> {
  const columns = ['owner_id', 'state', ...Object.keys(extra)];
  const values = [owner, state, ...Object.values(extra)];
  const params = values.map((_, i) => `$${i + 1}`);
  const result = await pool.query<{ id: string }>(
    `insert into fake_jobs (${columns.join(', ')}) values (${params.join(', ')}) returning id`,
    values,
  );
  return { id: (result.rows[0] as { id: string }).id, owner };
}

async function row(id: string): Promise<Record<string, unknown>> {
  const result = await pool.query('select * from fake_jobs where id = $1', [id]);
  return result.rows[0] as Record<string, unknown>;
}

function fakeBoss() {
  const send = vi.fn<(name: string, data?: object | null, options?: object) => Promise<string>>(async () => 'job-id');
  return { send: send as never, calls: send.mock.calls };
}

const accepted = (taskId = 'task-1'): SubmitResult => ({ kind: 'accepted', taskId });

describe('claimWithUserLimit (TC-CLP-03)', () => {
  it('holds the per-user running limit of 5 under concurrent claims, and other owners are unaffected', async () => {
    const owner = randomUUID();
    const ids = await Promise.all(Array.from({ length: 12 }, () => insert('pending', {}, owner)));
    const other = await insert();
    const outcomes = await Promise.all(
      ids.map(({ id }) => uow.run((tx) => claimWithUserLimit(tx, jobs, id))),
    );
    expect(outcomes.filter((o) => o.kind === 'claimed')).toHaveLength(RUN_LIMIT);
    expect(outcomes.filter((o) => o.kind === 'held')).toHaveLength(12 - RUN_LIMIT);
    const running = await pool.query(
      `select count(*)::int as n from fake_jobs where owner_id = $1 and state = 'submitting'`,
      [owner],
    );
    expect((running.rows[0] as { n: number }).n).toBe(RUN_LIMIT);
    expect((await uow.run((tx) => claimWithUserLimit(tx, jobs, other.id))).kind).toBe('claimed');

    // A finished job frees its place: a held job now claims.
    const claimed = ids.filter((_, i) => outcomes[i]?.kind === 'claimed');
    const held = ids.filter((_, i) => outcomes[i]?.kind === 'held');
    await pool.query(`update fake_jobs set state = 'completed' where id = $1`, [claimed[0]?.id]);
    const again = await uow.run((tx) => claimWithUserLimit(tx, jobs, held[0]?.id as string));
    expect(again.kind).toBe('claimed');
    const blocked = await uow.run((tx) => claimWithUserLimit(tx, jobs, held[1]?.id as string));
    expect(blocked).toMatchObject({ kind: 'held', running: RUN_LIMIT });
  });

  it('claims a pending row once, answers not_pending otherwise, and honours another limit or none', async () => {
    const { id, owner } = await insert();
    expect((await uow.run((tx) => claimWithUserLimit(tx, jobs, id))).kind).toBe('claimed');
    expect((await row(id))['submitting_at']).not.toBeNull();
    expect((await uow.run((tx) => claimWithUserLimit(tx, jobs, id))).kind).toBe('not_pending');
    expect((await uow.run((tx) => claimWithUserLimit(tx, jobs, randomUUID()))).kind).toBe(
      'not_pending',
    );
    const second = await insert('pending', {}, owner);
    expect(
      (await uow.run((tx) => claimWithUserLimit(tx, jobs, second.id, { limit: 1 }))).kind,
    ).toBe('held');
    expect(
      (await uow.run((tx) => claimWithUserLimit(tx, jobs, second.id, { limit: null }))).kind,
    ).toBe('claimed');
  });

  it('accepts only a plain identifier as the table name', () => {
    expect(() => jobTable('fake_jobs; drop table x')).toThrow(/invalid job table name/);
    expect(() => jobTable('Jobs')).toThrow(/invalid job table name/);
  });
});

describe('submitOnce: the at-most-once helper (TC-CLP-06, TC-PCA-01)', () => {
  it('two workers on one job make one provider call', async () => {
    const { id } = await insert();
    const call = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return accepted('task-two-workers');
    });
    const outcomes = await Promise.all([
      submitOnce({ uow, table: jobs, jobId: id, call }),
      submitOnce({ uow, table: jobs, jobId: id, call }),
    ]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['skipped', 'submitted']);
    expect(await row(id)).toMatchObject({
      state: 'submitted',
      provider_task_id: 'task-two-workers',
    });
    // A redelivery of the same queue job never calls again.
    expect((await submitOnce({ uow, table: jobs, jobId: id, call })).kind).toBe('skipped');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a kill between the call and the task-id write ends outcome_unknown, with no second call', async () => {
    const { id } = await insert();
    const call = vi.fn(async () => accepted('task-lost'));
    let runs = 0;
    const dying: TxScope = {
      run(fn) {
        runs += 1;
        // The claim commits; the process dies before the answer is recorded.
        if (runs === 2) return Promise.reject(new Error('process killed'));
        return uow.run(fn);
      },
    };
    await expect(submitOnce({ uow: dying, table: jobs, jobId: id, call })).rejects.toThrow(
      'process killed',
    );
    expect(await row(id)).toMatchObject({ state: 'submitting', provider_task_id: null });

    // Not yet orphaned: the sweep leaves it alone.
    expect(await uow.run((tx) => sweepSubmitOrphans(tx, jobs, 3600))).not.toContain(id);
    expect((await row(id))['state']).toBe('submitting');

    expect(await uow.run((tx) => sweepSubmitOrphans(tx, jobs, 0))).toContain(id);
    expect(await row(id)).toMatchObject({ state: 'failed', cause_class: 'outcome_unknown' });
    expect((await submitOnce({ uow, table: jobs, jobId: id, call })).kind).toBe('skipped');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a task id that arrives after the sweep is recorded, and the row is not revived', async () => {
    const { id } = await insert();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pending = submitOnce({
      uow,
      table: jobs,
      jobId: id,
      call: async () => {
        await gate;
        return accepted('task-late');
      },
    });
    await vi.waitFor(async () => expect((await row(id))['state']).toBe('submitting'));
    await uow.run((tx) => sweepSubmitOrphans(tx, jobs, 0));
    release();
    expect(await pending).toEqual({ kind: 'late_task_id', taskId: 'task-late' });
    expect(await row(id)).toMatchObject({
      state: 'failed',
      cause_class: 'outcome_unknown',
      provider_task_id: 'task-late',
    });
  });

  it('records a definitive rejection, and an unknown or thrown answer as outcome_unknown', async () => {
    const rejected = await insert();
    const outcome = await submitOnce({
      uow,
      table: jobs,
      jobId: rejected.id,
      call: async () => ({ kind: 'rejected', cause: 'configuration', message: 'bad key' }),
    });
    expect(outcome).toEqual({ kind: 'rejected', cause: 'configuration' });
    expect(await row(rejected.id)).toMatchObject({
      state: 'failed',
      cause_class: 'configuration',
      cause_message: 'bad key',
    });

    for (const call of [
      async (): Promise<SubmitResult> => ({ kind: 'unknown', message: '503' }),
      async (): Promise<SubmitResult> => Promise.reject(new Error('socket hang up')),
    ]) {
      const { id } = await insert();
      expect((await submitOnce({ uow, table: jobs, jobId: id, call })).kind).toBe(
        'outcome_unknown',
      );
      expect(await row(id)).toMatchObject({ state: 'failed', cause_class: 'outcome_unknown' });
    }
  });

  it('answers held without a call when the owner is at the limit', async () => {
    const owner = randomUUID();
    await Promise.all(Array.from({ length: 2 }, () => insert('processing', {}, owner)));
    const { id } = await insert('pending', {}, owner);
    const call = vi.fn(async () => accepted());
    expect((await submitOnce({ uow, table: jobs, jobId: id, call, limit: 2 })).kind).toBe('held');
    expect(call).not.toHaveBeenCalled();
    expect((await row(id))['state']).toBe('pending');
  });

  it('writes the task id and the first poll in one transaction', async () => {
    const boss = fakeBoss();
    const ok = await insert();
    const outcome = await submitOnce({
      uow,
      table: jobs,
      jobId: ok.id,
      call: async () => accepted('task-poll'),
      afterAccepted: async (tx) => {
        await schedulePoll(boss, tx, jobs, ok.id, timing.intervalSec);
      },
    });
    expect(outcome.kind).toBe('submitted');
    expect((await row(ok.id))['next_poll_at']).not.toBeNull();
    expect(boss.calls).toHaveLength(1);

    const broken = await insert();
    await expect(
      submitOnce({
        uow,
        table: jobs,
        jobId: broken.id,
        call: async () => accepted('task-rolled-back'),
        afterAccepted: async () => Promise.reject(new Error('enqueue failed')),
      }),
    ).rejects.toThrow('enqueue failed');
    expect(await row(broken.id)).toMatchObject({ state: 'submitting', provider_task_id: null });
  });

  it('the orphan hook sweeps through the registry and reports the ids', async () => {
    const { id } = await insert('submitting', { submitting_at: '2020-01-01T00:00:00Z' });
    const seen: string[] = [];
    const registry = new SweepRegistry();
    registry.register(
      submitOrphanHook('fake.submit-orphans', jobs, 300, async (ids) => void seen.push(...ids)),
    );
    const results = await registry.runAll((fn) => uow.run(fn));
    expect(results).toEqual([{ name: 'fake.submit-orphans', swept: expect.any(Number) }]);
    expect(seen).toContain(id);
    expect(await row(id)).toMatchObject({ state: 'failed', cause_class: 'outcome_unknown' });
    await expect(uow.run((tx) => sweepSubmitOrphans(tx, jobs, -1))).rejects.toThrow(/non-negative/);
  });
});

describe('schedulePoll and runPoll (TC-PCA-02)', () => {
  it('arms one live poll per job through the next_poll_at lease', async () => {
    const boss = fakeBoss();
    const { id } = await insert('submitted');
    const pendingJob = await insert('pending');
    const armed = await Promise.all([
      uow.run((tx) => schedulePoll(boss, tx, jobs, id, 5)),
      uow.run((tx) => schedulePoll(boss, tx, jobs, id, 5)),
    ]);
    expect(armed.sort()).toEqual([false, true]);
    expect(boss.calls).toHaveLength(1);
    expect(boss.calls[0]?.[0]).toBe(POLL_QUEUE);
    expect(boss.calls[0]?.[1]).toEqual({ jobId: id });
    expect(boss.calls[0]?.[2]).toMatchObject({ startAfter: 5, singletonKey: id });
    expect(await uow.run((tx) => schedulePoll(boss, tx, jobs, pendingJob.id, 5))).toBe(false);
    expect(boss.calls).toHaveLength(1);
  });

  it('a duplicate poll delivery makes one provider call', async () => {
    const boss = fakeBoss();
    const { id } = await insert('submitted', { next_poll_at: '2020-01-01T00:00:00Z' });
    const call = vi.fn(async (): Promise<PollResult> => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { kind: 'pending' };
    });
    const input = { boss: boss, uow, table: jobs, jobId: id, timing, call };
    const outcomes = await Promise.all([runPoll(input), runPoll(input)]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['polled', 'skipped']);
    expect(await row(id)).toMatchObject({ state: 'processing' });
    expect(boss.calls).toHaveLength(1);
    // The next poll is not due yet: an early delivery makes no call either.
    expect((await runPoll(input)).kind).toBe('skipped');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('completed stops polling and sets provider_completed_at; failed records the cause', async () => {
    const boss = fakeBoss();
    const done = await insert('processing', { next_poll_at: '2020-01-01T00:00:00Z' });
    const outcome = await runPoll({
      boss: boss,
      uow,
      table: jobs,
      jobId: done.id,
      timing,
      call: async () => ({ kind: 'completed' }),
    });
    expect(outcome).toEqual({ kind: 'polled', result: 'completed' });
    const completed = await row(done.id);
    expect(completed).toMatchObject({ state: 'processing', next_poll_at: null });
    expect(completed['provider_completed_at']).not.toBeNull();
    expect(boss.calls).toHaveLength(0);

    const bad = await insert('submitted', { next_poll_at: '2020-01-01T00:00:00Z' });
    await runPoll({
      boss: boss,
      uow,
      table: jobs,
      jobId: bad.id,
      timing,
      call: async () => ({ kind: 'failed', cause: 'temporary', message: 'provider said no' }),
    });
    expect(await row(bad.id)).toMatchObject({
      state: 'failed',
      cause_class: 'temporary',
      cause_message: 'provider said no',
    });
  });

  it('a failing provider call gives the lease back and rethrows for the queue retry', async () => {
    const { id } = await insert('submitted', { next_poll_at: '2020-01-01T00:00:00Z' });
    const input = {
      boss: fakeBoss(),
      uow,
      table: jobs,
      jobId: id,
      timing,
    };
    await expect(
      runPoll({ ...input, call: async () => Promise.reject(new Error('provider down')) }),
    ).rejects.toThrow('provider down');
    const call = vi.fn(async (): Promise<PollResult> => ({ kind: 'pending' }));
    expect((await runPoll({ ...input, call })).kind).toBe('polled');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('the deadline (TC-PCA-03)', () => {
  it('applies only while provider_completed_at is null', async () => {
    const overdue = '2020-01-01T00:00:00Z';
    const working = await insert('processing', { deadline_at: overdue });
    const copying = await insert('processing', {
      deadline_at: overdue,
      provider_completed_at: overdue,
    });
    const expired = await uow.run((tx) => expireOverdue(tx, jobs));
    expect(expired).toContain(working.id);
    expect(expired).not.toContain(copying.id);
    expect(await row(working.id)).toMatchObject({
      state: 'failed',
      cause_class: 'provider_timeout',
    });
    expect(await row(copying.id)).toMatchObject({ state: 'processing', cause_class: null });
  });

  it('a poll delivered past the deadline times the job out without calling the provider', async () => {
    const { id } = await insert('processing', {
      deadline_at: '2020-01-01T00:00:00Z',
      next_poll_at: '2020-01-01T00:00:00Z',
    });
    const call = vi.fn(async (): Promise<PollResult> => ({ kind: 'pending' }));
    const outcome = await runPoll({
      boss: fakeBoss(),
      uow,
      table: jobs,
      jobId: id,
      timing,
      call,
    });
    expect(outcome.kind).toBe('timed_out');
    expect(call).not.toHaveBeenCalled();
    expect((await row(id))['cause_class']).toBe('provider_timeout');
  });

  it('a future deadline does not time a job out', async () => {
    const { id } = await insert('processing', {
      deadline_at: '2999-01-01T00:00:00Z',
      next_poll_at: '2020-01-01T00:00:00Z',
    });
    const outcome = await runPoll({
      boss: fakeBoss(),
      uow,
      table: jobs,
      jobId: id,
      timing,
      call: async () => ({ kind: 'pending' }),
    });
    expect(outcome.kind).toBe('polled');
  });
});

describe('sweep hooks', () => {
  it('re-arms a lost poll, and not one that is merely due', async () => {
    const boss = fakeBoss();
    const lost = await insert('submitted', { next_poll_at: '2020-01-01T00:00:00Z' });
    const never = await insert('processing');
    const fresh = await insert('processing', {});
    await pool.query(`update fake_jobs set next_poll_at = now() where id = $1`, [fresh.id]);
    const hook = pollRearmHook('fake.poll-rearm', boss, jobs, timing);
    const result = await uow.run((tx) => hook.run(tx));
    expect(result.swept).toBeGreaterThanOrEqual(2);
    const sent = boss.calls.map((call) => (call[1] as { jobId: string }).jobId);
    expect(sent).toContain(lost.id);
    expect(sent).toContain(never.id);
    expect(sent).not.toContain(fresh.id);
  });

  it('runs every hook in order, isolating a failing one, and refuses a duplicate name', async () => {
    const registry = new SweepRegistry();
    const order: string[] = [];
    registry.register({
      name: 'a',
      async run() {
        order.push('a');
        return { swept: 2 };
      },
    });
    registry.register({
      name: 'broken',
      async run(tx: DbTx) {
        await tx.execute('select 1' as never).catch(() => undefined);
        throw new Error('boom');
      },
    });
    registry.register({
      name: 'c',
      async run() {
        order.push('c');
        return { swept: 0 };
      },
    });
    expect(() => registry.register({ name: 'a', run: async () => ({ swept: 0 }) })).toThrow(
      DuplicateSweepHookError,
    );
    expect(registry.names()).toEqual(['a', 'broken', 'c']);
    const results = await registry.runAll((fn) => uow.run(fn));
    expect(results).toEqual([
      { name: 'a', swept: 2 },
      { name: 'broken', swept: 0, error: 'boom' },
      { name: 'c', swept: 0 },
    ]);
    expect(order).toEqual(['a', 'c']);
    const stringy = new SweepRegistry();
    stringy.register({ name: 's', run: () => Promise.reject('plain') });
    expect((await stringy.runAll((fn) => uow.run(fn)))[0]?.error).toBe('plain');
  });
});
