import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { ClaimCountsService } from '../../brief/index.js';
import type { ClaimCheckCounts } from '../../brief/index.js';
import { VideoJobsService } from '../../production/index.js';
import { isFault, resolveWindow } from '../domain/window.js';
import type { ReportWindow } from '../domain/window.js';
import { REPORTING_CLOCK, REPORTING_CONFIG, REPORTING_USAGE } from './ports.js';
import type { AccountUsageRow, ProviderUsageRow, ReportingConfig, UsageReportReader } from './ports.js';

export interface ProviderUsage {
  provider: string;
  calls: number;
  succeeded: number;
  failed: number;
  rejected: number;
  unconfirmed: number;
  estimatedCostUsd: string;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export interface UsageReportView {
  from: string;
  to: string;
  asOf: string;
  empty: boolean;
  costBasis: 'estimate_from_configured_price_table';
  accounts: { userId: string; providers: ProviderUsage[] }[];
  providers: ProviderUsage[];
  jobStates: Record<string, number>;
  claimChecks: ClaimCheckCounts[];
}

const providerView = (row: ProviderUsageRow): ProviderUsage => ({
  provider: row.provider,
  calls: row.calls,
  succeeded: row.succeeded,
  failed: row.failed,
  rejected: row.rejected,
  unconfirmed: row.unconfirmed,
  estimatedCostUsd: row.estimatedCostUsd,
  latencyP50Ms: row.latencyP50Ms,
  latencyP95Ms: row.latencyP95Ms,
});

const unavailable = (): DomainError =>
  new DomainError('service_unavailable', 'The report could not be produced right now. Try again shortly.');

/** Every source gets the same budget as the report query; a slow one fails the report like a broken one (never zeros). */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('data source timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** `usageReport(window)` (REQ-021): usage events, job counters and claim-check counts, composed read-only. */
@Injectable()
export class UsageReportService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(REPORTING_USAGE) private readonly usage: UsageReportReader,
    @Inject(VideoJobsService) private readonly jobs: Pick<VideoJobsService, 'jobStatsWindow'>,
    @Inject(ClaimCountsService) private readonly claims: Pick<ClaimCountsService, 'claimCounts'>,
    @Inject(REPORTING_CONFIG) private readonly config: ReportingConfig,
    @Inject(REPORTING_CLOCK) private readonly clock: () => Date,
  ) {}

  /** Resolves `from`/`to` (defaults, order, the 366-day limit); refuses with 422 `report_window_too_large` or 400. */
  window(input: { from?: Date | undefined; to?: Date | undefined }): ReportWindow {
    const resolved = resolveWindow(input, this.clock(), {
      defaultDays: this.config.defaultWindowDays,
      maxDays: this.config.maxWindowDays,
    });
    if (!isFault(resolved)) return resolved;
    if (resolved.kind === 'invalid') {
      throw new DomainError('validation_failed', 'The request is not valid.', [
        { field: resolved.field, code: 'window_order', message: resolved.message },
      ]);
    }
    throw new DomainError(
      'report_window_too_large',
      `The reporting window must be at most ${String(resolved.maxDays)} days.`,
      [{ field: 'window', code: 'max_days', message: `at most ${String(resolved.maxDays)} days` }],
    );
  }

  async usageReport(window: ReportWindow): Promise<UsageReportView> {
    const budget = this.config.statementTimeoutMs;
    let totals: Awaited<ReturnType<UsageReportReader['totals']>>;
    let jobStats: Awaited<ReturnType<VideoJobsService['jobStatsWindow']>>;
    let claimChecks: readonly ClaimCheckCounts[];
    try {
      [totals, jobStats, claimChecks] = await Promise.all([
        this.database.uow.run((tx) => this.usage.totals(tx, window.from, window.to), { statementTimeoutMs: budget }),
        within(this.jobs.jobStatsWindow(window.from, window.to), budget),
        within(this.claims.claimCounts({ from: window.from, to: window.to }), budget),
      ]);
    } catch {
      throw unavailable();
    }
    const byAccount = new Map<string, ProviderUsage[]>();
    for (const row of totals.accounts as readonly AccountUsageRow[]) {
      const list = byAccount.get(row.userId) ?? [];
      list.push(providerView(row));
      byAccount.set(row.userId, list);
    }
    const jobStates: Record<string, number> = {
      videoCreated: jobStats.videoCreated,
      videoCompleted: jobStats.videoCompleted,
      videoFailed: jobStats.videoFailed,
      videoCancelled: jobStats.videoCancelled,
      qcCreated: jobStats.qcCreated,
    };
    const claimTotal = claimChecks.reduce((n, c) => n + c.raised + c.closedByEdit + c.clearedWithReason, 0);
    const empty =
      totals.providers.length === 0 && Object.values(jobStates).every((n) => n === 0) && claimTotal === 0;
    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      asOf: this.clock().toISOString(),
      empty,
      costBasis: 'estimate_from_configured_price_table',
      accounts: [...byAccount].map(([userId, providers]) => ({ userId, providers })),
      providers: totals.providers.map(providerView),
      jobStates: empty ? {} : jobStates,
      claimChecks: empty ? [] : [...claimChecks],
    };
  }
}
