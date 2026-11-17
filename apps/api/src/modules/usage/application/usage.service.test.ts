import { describe, expect, it } from 'vitest';
import type { DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { toUnits } from '../domain/money.js';
import { PriceMissingError } from '../domain/types.js';
import type { BillableCall } from '../domain/types.js';
import { FakeUsageRepository, fakeDatabase } from './fakes.js';
import { UsageService } from './usage.service.js';

const OWNER = '0197a1b2-0000-7000-8000-000000000001';
const JOB = '0197a1b2-0000-7000-8000-0000000000a1';
const TEXT: BillableCall = { provider: 'openai', operation: 'text' };
const VIDEO: BillableCall = { provider: 'wavespeed', operation: 'video' };

function build(opts: { daily?: number; monthly?: number; now?: Date } = {}) {
  const repository = new FakeUsageRepository();
  repository.setPrice(TEXT, toUnits('0.25'));
  repository.setPrice(VIDEO, toUnits('1.5'));
  const { database, executed } = fakeDatabase();
  let now = opts.now ?? new Date('2026-11-16T12:00:00Z');
  const service = new UsageService(
    database,
    repository,
    { dailyCapUnits: toUnits(opts.daily ?? 1), monthlyCapUnits: toUnits(opts.monthly ?? 10) },
    () => now,
  );
  const run = <T>(fn: (tx: DbTx) => Promise<T>): Promise<T> => database.uow.run(fn);
  return { repository, service, run, executed, setNow: (d: Date) => (now = d) };
}

const refusal = async (promise: Promise<unknown>): Promise<DomainError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
};

describe('estimate', () => {
  it('returns the price row estimate and refuses a missing row as 503', async () => {
    const { service } = build();
    expect(await service.estimate(TEXT)).toBe('0.2500');
    const missing = { provider: 'openai', operation: 'nope' } as const;
    await expect(service.estimate(missing)).rejects.toBeInstanceOf(PriceMissingError);
    const error = await refusal(service.estimateOrRefuse(missing));
    expect(error.code).toBe('service_unavailable');
    expect(error.status).toBe(503);
    expect(await service.estimateOrRefuse(TEXT)).toBe('0.2500');
  });

  it('assertPriced stops at the first call with no price', async () => {
    const { service } = build();
    await service.assertPriced([TEXT, VIDEO]);
    await expect(
      service.assertPriced([TEXT, { provider: 'openai', operation: 'x' }]),
    ).rejects.toMatchObject({
      call: { operation: 'x' },
    });
  });
});

describe('reserve and checkCap', () => {
  it('sums the estimates, takes the owner lock and stores one reservation per job', async () => {
    const { service, run, repository, executed } = build({ daily: 5 });
    const first = await run((tx) =>
      service.reserve(tx, { ownerId: OWNER, jobType: 'video', jobId: JOB, calls: [VIDEO, TEXT] }),
    );
    expect(first).toMatchObject({ estimatedCostUsd: '1.7500', remainingCalls: 2, created: true });
    expect(executed).toHaveLength(1);
    const again = await run((tx) =>
      service.reserve(tx, { ownerId: OWNER, jobType: 'video', jobId: JOB, calls: [VIDEO, TEXT] }),
    );
    expect(again).toMatchObject({ id: first.id, created: false });
    expect(repository.reservations).toHaveLength(1);
  });

  it('refuses a reservation with no call', async () => {
    const { service, run } = build();
    await expect(
      run((tx) => service.reserve(tx, { ownerId: OWNER, jobType: 'qc', jobId: JOB, calls: [] })),
    ).rejects.toThrow(RangeError);
  });

  it('refuses a missing price as 503 and writes nothing', async () => {
    const { service, run, repository } = build();
    const error = await refusal(
      run((tx) =>
        service.reserve(tx, {
          ownerId: OWNER,
          jobType: 'qc',
          jobId: JOB,
          calls: [{ provider: 'openai', operation: 'nope' }],
        }),
      ),
    );
    expect(error.code).toBe('service_unavailable');
    expect(repository.reservations).toEqual([]);
  });

  it('allows up to the cap and refuses past it, naming the limit and the estimate basis', async () => {
    const { service, run } = build({ daily: 1 });
    const reserve = (n: number) =>
      run((tx) =>
        service.reserve(tx, {
          ownerId: OWNER,
          jobType: 'brief_generation',
          jobId: `0197a1b2-0000-7000-8000-00000000010${String(n)}`,
          calls: [TEXT],
        }),
      );
    for (const n of [0, 1, 2, 3]) await reserve(n);
    const error = await refusal(reserve(4));
    expect(error.code).toBe('spend_cap_reached');
    expect(error.status).toBe(422);
    expect(error.safeMessage).toContain('daily spending limit of US$1.00');
    expect(error.safeMessage).toContain('estimates from the price table');
    expect(error.details).toEqual([
      { field: 'limit', code: 'daily', message: 'US$1.00 per UTC day' },
      {
        field: 'estimateBasis',
        code: 'price_table',
        message: 'recorded US$0.00 + reserved US$1.00 + new US$0.25',
      },
    ]);
  });

  it('refuses on the monthly cap when the daily one still has room', async () => {
    const { service, run, repository } = build({ daily: 5, monthly: 6 });
    repository.totalsOverride = {
      dayUnits: toUnits('0'),
      monthUnits: toUnits('5.9'),
      reservedUnits: 0,
    };
    const error = await refusal(run((tx) => service.checkCap(tx, OWNER, 0.25)));
    expect(error.details?.[0]).toMatchObject({ code: 'monthly', message: 'US$6.00 per UTC month' });
    await run((tx) => service.checkCap(tx, OWNER, '0.1'));
  });

  it('computes the UTC day and month windows from the clock', async () => {
    const { service, run, repository, setNow } = build({ daily: 5 });
    setNow(new Date('2026-03-31T23:59:30Z'));
    await run((tx) => service.checkCap(tx, OWNER, 0));
    setNow(new Date('2026-04-01T00:01:00Z'));
    await run((tx) => service.checkCap(tx, OWNER, 0));
    expect(
      repository.totalsArgs.map((a) => [a.dayStart.toISOString(), a.monthStart.toISOString()]),
    ).toEqual([
      ['2026-03-31T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
      ['2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ]);
  });
});

describe('record, convertUnconfirmed and release', () => {
  const reserved = async (calls: BillableCall[] = [VIDEO, TEXT]) => {
    const ctx = build({ daily: 20, monthly: 20 });
    await ctx.run((tx) =>
      ctx.service.reserve(tx, { ownerId: OWNER, jobType: 'video', jobId: JOB, calls }),
    );
    return ctx;
  };
  const call = (over: object = {}) => ({
    ownerId: OWNER,
    call: VIDEO,
    jobType: 'video' as const,
    jobId: JOB,
    callSeq: 1,
    ...over,
  });

  it('records the estimate and takes that call off the reservation; the last call deletes it', async () => {
    const { service, run, repository } = await reserved();
    expect(
      await run((tx) => service.record(tx, { ...call(), outcome: 'succeeded', latencyMs: 40 })),
    ).toEqual({ recorded: true, costUsd: '1.5000' });
    expect(repository.reservations[0]).toMatchObject({
      estimatedUnits: toUnits('0.25'),
      remainingCalls: 1,
    });
    expect(repository.events[0]).toMatchObject({
      outcome: 'succeeded',
      costBasis: 'estimate',
      latencyMs: 40,
    });
    await run((tx) =>
      service.record(tx, { ...call({ call: TEXT, callSeq: 2 }), outcome: 'failed' }),
    );
    expect(repository.reservations).toEqual([]);
    expect(repository.events[1]).toMatchObject({
      outcome: 'failed',
      costUnits: toUnits('0.25'),
      latencyMs: null,
    });
  });

  it('records a definitive rejection at zero cost but still releases the call from the reservation', async () => {
    const { service, run, repository } = await reserved();
    expect(await run((tx) => service.record(tx, { ...call(), outcome: 'rejected' }))).toEqual({
      recorded: true,
      costUsd: '0.0000',
    });
    expect(repository.events[0]).toMatchObject({
      outcome: 'rejected',
      costBasis: 'zero_rejected',
      costUnits: 0,
    });
    expect(repository.reservations[0]?.estimatedUnits).toBe(toUnits('0.25'));
  });

  it('is idempotent: a repeat changes neither the events nor the reservation', async () => {
    const { service, run, repository } = await reserved();
    await run((tx) => service.record(tx, { ...call(), outcome: 'succeeded' }));
    const again = await run((tx) => service.record(tx, { ...call(), outcome: 'succeeded' }));
    expect(again.recorded).toBe(false);
    expect(repository.events).toHaveLength(1);
    expect(repository.reservations[0]?.remainingCalls).toBe(1);
  });

  it('converts an unknown outcome to an unconfirmed event that keeps the estimate; a late response changes nothing', async () => {
    const { service, run, repository } = await reserved([VIDEO]);
    expect(await run((tx) => service.convertUnconfirmed(tx, call()))).toEqual({
      recorded: true,
      costUsd: '1.5000',
    });
    expect(repository.events[0]).toMatchObject({
      outcome: 'unconfirmed',
      costBasis: 'unconfirmed_estimate',
      costUnits: toUnits('1.5'),
    });
    expect(repository.reservations).toEqual([]);
    expect((await run((tx) => service.convertUnconfirmed(tx, call()))).recorded).toBe(false);
    expect(
      (await run((tx) => service.record(tx, { ...call(), outcome: 'succeeded' }))).recorded,
    ).toBe(false);
    expect(repository.events).toHaveLength(1);
  });

  it('records a call that has no reservation (the late response of a released job)', async () => {
    const { service, run, repository } = build();
    expect(
      (await run((tx) => service.record(tx, { ...call({ call: TEXT }), outcome: 'succeeded' })))
        .recorded,
    ).toBe(true);
    expect(repository.events).toHaveLength(1);
  });

  it('refuses a call sequence below 1 and an unpriced call', async () => {
    const { service, run, repository } = await reserved();
    await expect(
      run((tx) => service.record(tx, { ...call({ callSeq: 0 }), outcome: 'succeeded' })),
    ).rejects.toThrow(RangeError);
    await expect(
      run((tx) =>
        service.record(tx, {
          ...call({ call: { provider: 'openai', operation: 'nope' } }),
          outcome: 'succeeded',
        }),
      ),
    ).rejects.toBeInstanceOf(PriceMissingError);
    expect(repository.events).toEqual([]);
  });

  it('releases a reservation once', async () => {
    const { service, run, repository } = await reserved();
    expect(
      await run((tx) => service.release(tx, { ownerId: OWNER, jobType: 'video', jobId: JOB })),
    ).toBe(true);
    expect(
      await run((tx) => service.release(tx, { ownerId: OWNER, jobType: 'video', jobId: JOB })),
    ).toBe(false);
    expect(repository.reservations).toEqual([]);
  });
});
