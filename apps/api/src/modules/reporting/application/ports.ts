import type { DbTx } from '../../../platform/db/index.js';

export const REPORTING_CONFIG = Symbol('REPORTING_CONFIG');
export const REPORTING_CLOCK = Symbol('REPORTING_CLOCK');
export const REPORTING_USAGE = Symbol('REPORTING_USAGE');

export interface ReportingConfig {
  readonly defaultWindowDays: number;
  readonly maxWindowDays: number;
  /** `SET LOCAL statement_timeout` of the report query. */
  readonly statementTimeoutMs: number;
}

export interface ProviderUsageRow {
  readonly provider: 'openai' | 'wavespeed' | 'assembly_vendor';
  readonly calls: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly rejected: number;
  readonly unconfirmed: number;
  /** Sum of the recorded estimates, US dollars with four decimals. */
  readonly estimatedCostUsd: string;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
}

export interface AccountUsageRow extends ProviderUsageRow {
  readonly userId: string;
}

export interface UsageTotals {
  readonly accounts: readonly AccountUsageRow[];
  readonly providers: readonly ProviderUsageRow[];
}

/** Usage events counted by event time in `[from, to)`: per account and provider, and per provider over all accounts. */
export interface UsageReportReader {
  totals(tx: DbTx, from: Date, to: Date): Promise<UsageTotals>;
}
