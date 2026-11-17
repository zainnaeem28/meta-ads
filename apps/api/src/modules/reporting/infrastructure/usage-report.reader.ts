import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../platform/db/index.js';
import type { AccountUsageRow, ProviderUsageRow, UsageReportReader, UsageTotals } from '../application/ports.js';

interface Raw extends Record<string, unknown> {
  owner_id: string | null;
  provider: ProviderUsageRow['provider'];
  calls: string;
  succeeded: string;
  failed: string;
  rejected: string;
  unconfirmed: string;
  cost: string;
  p50: string | null;
  p95: string | null;
}

const provider = (r: Raw): ProviderUsageRow => ({
  provider: r.provider,
  calls: Number(r.calls),
  succeeded: Number(r.succeeded),
  failed: Number(r.failed),
  rejected: Number(r.rejected),
  unconfirmed: Number(r.unconfirmed),
  estimatedCostUsd: Number(r.cost).toFixed(4),
  latencyP50Ms: r.p50 === null ? null : Number(r.p50),
  latencyP95Ms: r.p95 === null ? null : Number(r.p95),
});

/** Read-only aggregate of `usage_events` (counts, estimates and latencies only; never a key, hint, content or email). */
@Injectable()
export class DrizzleUsageReportReader implements UsageReportReader {
  async totals(tx: DbTx, from: Date, to: Date): Promise<UsageTotals> {
    // One pass: grouping sets give the per-account rows and the all-accounts rows together.
    const result = await tx.execute<Raw>(sql`
      select owner_id, provider,
             count(*)::text as calls,
             (count(*) filter (where outcome = 'succeeded'))::text as succeeded,
             (count(*) filter (where outcome = 'failed'))::text as failed,
             (count(*) filter (where outcome = 'rejected'))::text as rejected,
             (count(*) filter (where outcome = 'unconfirmed'))::text as unconfirmed,
             coalesce(sum(estimated_cost_usd), 0)::text as cost,
             (percentile_disc(0.5) within group (order by latency_ms))::text as p50,
             (percentile_disc(0.95) within group (order by latency_ms))::text as p95
        from usage_events
       where at >= ${from.toISOString()}::timestamptz and at < ${to.toISOString()}::timestamptz
       group by grouping sets ((owner_id, provider), (provider))
       order by owner_id nulls last, provider`);
    const accounts: AccountUsageRow[] = [];
    const providers: ProviderUsageRow[] = [];
    for (const row of result.rows) {
      if (row.owner_id === null) providers.push(provider(row));
      else accounts.push({ userId: row.owner_id, ...provider(row) });
    }
    return { accounts, providers };
  }
}
