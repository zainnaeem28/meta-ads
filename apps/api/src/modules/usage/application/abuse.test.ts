import { describe, expect, it, vi } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import { UnitOfWork } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import type { AlertPort } from '../../audit/index.js';
import { AbuseMonitor } from './abuse.js';
import { MAX_WINDOW_DAYS, UsageAggregator } from './aggregate.js';

const OWNER = '0197a1b2-0000-7000-8000-000000000001';
const CONFIG = { jobBurstCount: 20, authSpikeCount: 5, windowMinutes: 10 };

function databaseReturning(rows: Record<string, unknown>[]): Pick<Database, 'uow'> {
  const tx = { execute: () => Promise.resolve({ rows }) } as unknown as DbTx;
  return { uow: new UnitOfWork({ transaction: (fn) => fn(tx) }) } as unknown as Pick<
    Database,
    'uow'
  >;
}

function monitor(jobs: number, now: { value: Date }, raised = true) {
  const announce = vi.fn();
  const raiseAlert = vi.fn(() => Promise.resolve({ raised, alertId: 'a', announce }));
  const modules = { get: () => ({ raiseAlert }) as unknown as AlertPort } as unknown as ModuleRef;
  return {
    raiseAlert,
    announce,
    abuse: new AbuseMonitor(
      databaseReturning([{ jobs: String(jobs) }]),
      CONFIG,
      () => now.value,
      modules,
    ),
  };
}

describe('checkAbuseThresholds (TC-ALR-01..03)', () => {
  it('raises one job_burst alert at 21 jobs and none at 20', async () => {
    const now = { value: new Date('2026-05-01T10:00:00Z') };
    const over = monitor(21, now);
    expect(await over.abuse.checkAbuseThresholds(OWNER)).toMatchObject({
      jobBurst: true,
      providerAuthSpike: false,
      jobs: 21,
    });
    expect(over.raiseAlert).toHaveBeenCalledTimes(1);
    expect(over.raiseAlert).toHaveBeenCalledWith(expect.anything(), 'job_burst', OWNER, {
      jobs: 21,
      window_min: 10,
    });
    expect(over.announce).toHaveBeenCalledTimes(1);
    const at = monitor(20, now);
    expect(await at.abuse.checkAbuseThresholds(OWNER)).toMatchObject({ jobBurst: false });
    expect(at.raiseAlert).not.toHaveBeenCalled();
  });

  it('raises one provider_auth_spike alert at 5 responses in 10 minutes, none at 4, and forgets old ones', async () => {
    const now = { value: new Date('2026-05-01T10:00:00Z') };
    const m = monitor(0, now);
    for (let i = 0; i < 4; i += 1) m.abuse.noteProviderAuthResponse(OWNER, i % 2 === 0 ? 401 : 429);
    expect((await m.abuse.checkAbuseThresholds(OWNER)).providerAuthSpike).toBe(false);
    expect(m.raiseAlert).not.toHaveBeenCalled();
    m.abuse.noteProviderAuthResponse(OWNER, 401);
    expect(await m.abuse.checkAbuseThresholds(OWNER)).toMatchObject({
      providerAuthSpike: true,
      authResponses: 5,
    });
    expect(m.raiseAlert).toHaveBeenCalledWith(expect.anything(), 'provider_auth_spike', OWNER, {
      responses: 5,
      window_min: 10,
    });
    now.value = new Date('2026-05-01T10:11:00Z');
    expect((await m.abuse.checkAbuseThresholds(OWNER)).authResponses).toBe(0);
  });

  it('reports no new alert when one is already open, and counts accounts separately', async () => {
    const now = { value: new Date('2026-05-01T10:00:00Z') };
    const m = monitor(30, now, false);
    expect((await m.abuse.checkAbuseThresholds(OWNER)).jobBurst).toBe(false);
    m.abuse.noteProviderAuthResponse('other', 429);
    expect((await m.abuse.checkAbuseThresholds(OWNER)).authResponses).toBe(0);
    expect(() => m.abuse.noteProviderAuthResponse(OWNER, 500 as 401)).toThrow(RangeError);
  });
});

describe('aggregate (TC-USG)', () => {
  const clock = () => new Date('2026-05-01T00:00:00Z');

  it('refuses a window above 366 days (or not a positive whole number) naming the limit', async () => {
    const aggregator = new UsageAggregator(databaseReturning([]), clock);
    for (const days of [367, 0, 1.5, -1]) {
      const error: unknown = await aggregator.aggregate(days).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DomainError);
      expect(JSON.stringify((error as DomainError).details)).toContain(String(MAX_WINDOW_DAYS));
    }
  });

  it('returns an empty list, not zeros, for an empty window; default window is 30 days', async () => {
    const result = await new UsageAggregator(databaseReturning([]), clock).aggregate();
    expect(result.rows).toEqual([]);
    expect(result.from).toBe('2026-04-01T00:00:00.000Z');
  });

  it('maps rows to counts, cost, latency and job states only', async () => {
    const database = databaseReturning([
      {
        owner_id: OWNER,
        provider: 'openai',
        calls: '3',
        successes: '2',
        failures: '1',
        rejected: '0',
        unconfirmed: '0',
        cost: '0.75',
        latency: '120',
        js: '2',
        jf: '1',
        jr: '0',
        ju: '0',
      },
      {
        owner_id: OWNER,
        provider: 'wavespeed',
        calls: '1',
        successes: '0',
        failures: '0',
        rejected: '1',
        unconfirmed: '0',
        cost: '0',
        latency: null,
        js: '0',
        jf: '0',
        jr: '1',
        ju: '0',
      },
    ]);
    const { rows } = await new UsageAggregator(database, clock).aggregate(MAX_WINDOW_DAYS);
    expect(rows[0]).toEqual({
      ownerId: OWNER,
      provider: 'openai',
      calls: 3,
      successes: 2,
      failures: 1,
      rejected: 0,
      unconfirmed: 0,
      estimatedCostUsd: '0.7500',
      averageLatencyMs: 120,
      jobStates: { succeeded: 2, failed: 1, rejected: 0, unconfirmed: 0 },
    });
    expect(rows[1]?.averageLatencyMs).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/email|content|key/i);
  });
});
