import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../platform/http/domain-error.js';
import { UsageReportService } from './usage-report.service.js';
import type { UsageReportReader, UsageTotals } from './ports.js';

const now = new Date('2026-06-30T12:00:00Z');
const config = { defaultWindowDays: 30, maxWindowDays: 366, statementTimeoutMs: 50 };
const stats = { windowStart: '', windowEnd: '', videoCreated: 0, videoCompleted: 0, videoFailed: 0, videoCancelled: 0, qcCreated: 0 };
const zeroClaims = [
  { class: 'high_risk', raised: 0, closedByEdit: 0, clearedWithReason: 0 },
  { class: 'other', raised: 0, closedByEdit: 0, clearedWithReason: 0 },
] as const;
const row = { provider: 'openai', calls: 2, succeeded: 1, failed: 1, rejected: 0, unconfirmed: 0, estimatedCostUsd: '0.0200', latencyP50Ms: 10, latencyP95Ms: 20 } as const;

function make(over: { totals?: UsageTotals | Error; jobs?: unknown; claims?: unknown } = {}) {
  const totals = over.totals ?? { accounts: [], providers: [] };
  const reader: UsageReportReader = {
    totals: () => (totals instanceof Error ? Promise.reject(totals) : Promise.resolve(totals)),
  };
  const database = { uow: { run: <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never) } };
  return new UsageReportService(
    database as never,
    reader,
    { jobStatsWindow: () => (over.jobs instanceof Error ? Promise.reject(over.jobs) : Promise.resolve(over.jobs ?? stats)) } as never,
    { claimCounts: () => (over.claims instanceof Error ? Promise.reject(over.claims) : Promise.resolve(over.claims ?? zeroClaims)) } as never,
    config,
    () => now,
  );
}

describe('UsageReportService', () => {
  it('returns an empty report (empty arrays, empty: true), not zeros, and the as-of time', async () => {
    const service = make();
    const report = await service.usageReport(service.window({}));
    expect(report).toMatchObject({ empty: true, accounts: [], providers: [], jobStates: {}, claimChecks: [], asOf: now.toISOString() });
  });

  it('groups provider rows under their account and keeps the job and claim counts', async () => {
    const service = make({
      totals: { accounts: [{ userId: 'u1', ...row }], providers: [row] },
      jobs: { ...stats, videoCreated: 3 },
      claims: [{ class: 'high_risk', raised: 1, closedByEdit: 0, clearedWithReason: 0 }, zeroClaims[1]],
    });
    const report = await service.usageReport(service.window({}));
    expect(report.empty).toBe(false);
    expect(report.accounts).toEqual([{ userId: 'u1', providers: [row] }]);
    expect(report.jobStates['videoCreated']).toBe(3);
    expect(report.claimChecks).toHaveLength(2);
  });

  it.each([
    ['usage', { totals: new Error('boom') }],
    ['jobs', { jobs: new Error('boom') }],
    ['claims', { claims: new Error('boom') }],
  ])('answers 503 when the %s source fails, never zeros', async (_name, over) => {
    const service = make(over);
    await expect(service.usageReport(service.window({}))).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('refuses a window above 366 days with 422 and the limit', () => {
    const service = make();
    try {
      service.window({ from: new Date('2025-01-01T00:00:00Z'), to: now });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: 'report_window_too_large', status: 422 });
      expect((error as DomainError).message).toContain('366');
    }
  });

  it('refuses a backwards window with 400 validation_failed', () => {
    expect(() => make().window({ from: now, to: new Date('2026-06-01T00:00:00Z') })).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });
});
