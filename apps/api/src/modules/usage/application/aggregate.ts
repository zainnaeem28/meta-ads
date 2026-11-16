import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { USAGE_CLOCK } from './ports.js';
import type { Clock } from './ports.js';

export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 366;

export interface AggregateRow {
  /** The account's user id; never an email or a name. */
  readonly ownerId: string;
  readonly provider: string;
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly rejected: number;
  readonly unconfirmed: number;
  /** Sum of the recorded estimates, US dollars with four decimals. */
  readonly estimatedCostUsd: string;
  /** Mean of the recorded call latencies; null when none was recorded. */
  readonly averageLatencyMs: number | null;
  /** Distinct jobs by the outcome of their latest recorded call. */
  readonly jobStates: Readonly<Record<'succeeded' | 'failed' | 'rejected' | 'unconfirmed', number>>;
}

export interface UsageAggregate {
  readonly from: string;
  readonly to: string;
  /** Empty when nothing was recorded in the window (not rows of zeros). */
  readonly rows: readonly AggregateRow[];
}

/** Per-account, per-provider usage totals for reporting (REQ-021). Counts and costs only. */
@Injectable()
export class UsageAggregator {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(USAGE_CLOCK) private readonly clock: Clock,
  ) {}

  /** `windowDays` defaults to 30; more than 366 (or not a positive whole number) is refused naming the limit. */
  async aggregate(windowDays: number = DEFAULT_WINDOW_DAYS): Promise<UsageAggregate> {
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_WINDOW_DAYS) {
      throw new DomainError(
        'report_window_too_large',
        `The reporting window must be between 1 and ${String(MAX_WINDOW_DAYS)} days.`,
        [{ field: 'window', code: 'max_days', message: `at most ${String(MAX_WINDOW_DAYS)} days` }],
      );
    }
    const to = this.clock();
    const from = new Date(to.getTime() - windowDays * 86_400_000);
    const rows = await this.database.uow.run(async (tx) => {
      const result = await tx.execute<{
        owner_id: string;
        provider: string;
        calls: string;
        successes: string;
        failures: string;
        rejected: string;
        unconfirmed: string;
        cost: string;
        latency: string | null;
        js: string;
        jf: string;
        jr: string;
        ju: string;
      }>(sql`
        with scoped as (
          select * from usage_events where at >= ${from.toISOString()}::timestamptz and at <= ${to.toISOString()}::timestamptz
        ), latest as (
          select distinct on (job_type, job_id) owner_id, provider, outcome
            from scoped order by job_type, job_id, call_seq desc
        ), jobs as (
          select owner_id, provider,
                 count(*) filter (where outcome = 'succeeded') as js, count(*) filter (where outcome = 'failed') as jf,
                 count(*) filter (where outcome = 'rejected') as jr, count(*) filter (where outcome = 'unconfirmed') as ju
            from latest group by owner_id, provider
        ), calls as (
          select owner_id, provider, count(*) as calls,
                 count(*) filter (where outcome = 'succeeded') as successes,
                 count(*) filter (where outcome = 'failed') as failures,
                 count(*) filter (where outcome = 'rejected') as rejected,
                 count(*) filter (where outcome = 'unconfirmed') as unconfirmed,
                 sum(estimated_cost_usd) as cost, avg(latency_ms) as latency
            from scoped group by owner_id, provider
        )
        select c.owner_id, c.provider, c.calls::text, c.successes::text, c.failures::text, c.rejected::text,
               c.unconfirmed::text, c.cost::text, round(c.latency)::text as latency,
               coalesce(j.js, 0)::text as js, coalesce(j.jf, 0)::text as jf, coalesce(j.jr, 0)::text as jr,
               coalesce(j.ju, 0)::text as ju
          from calls c left join jobs j using (owner_id, provider)
         order by c.owner_id, c.provider`);
      return result.rows;
    });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      rows: rows.map((r) => ({
        ownerId: r.owner_id,
        provider: r.provider,
        calls: Number(r.calls),
        successes: Number(r.successes),
        failures: Number(r.failures),
        rejected: Number(r.rejected),
        unconfirmed: Number(r.unconfirmed),
        estimatedCostUsd: Number(r.cost).toFixed(4),
        averageLatencyMs: r.latency === null ? null : Number(r.latency),
        jobStates: {
          succeeded: Number(r.js),
          failed: Number(r.jf),
          rejected: Number(r.jr),
          unconfirmed: Number(r.ju),
        },
      })),
    };
  }
}
