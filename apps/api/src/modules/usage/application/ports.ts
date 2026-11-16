import type { DbTx } from '../../../platform/db/index.js';
import type { BillableCall, CostBasis, JobType, PriceRow, UsageOutcome } from '../domain/types.js';
import type { Units } from '../domain/money.js';

export interface NewUsageEvent {
  readonly id: string;
  readonly ownerId: string;
  readonly call: BillableCall;
  readonly jobType: JobType;
  readonly jobId: string;
  readonly callSeq: number;
  readonly outcome: UsageOutcome;
  readonly costUnits: Units;
  readonly costBasis: CostBasis;
  readonly latencyMs: number | null;
  readonly at: Date;
}

export interface ReservationRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly jobType: JobType;
  readonly jobId: string;
  readonly estimatedUnits: Units;
  readonly remainingCalls: number;
}

export interface SpendTotals {
  /** Recorded estimated cost since the start of the UTC day. */
  readonly dayUnits: Units;
  /** Recorded estimated cost since the start of the UTC month. */
  readonly monthUnits: Units;
  /** Estimates of every call of the owner's jobs that is not yet made. */
  readonly reservedUnits: Units;
}

/** Module-private persistence; other modules never see it. Every method runs in the caller's transaction. */
export interface UsageRepository {
  /** The estimate of one call (`unit_price_usd × units_per_call`, four decimals) from the row in force on `day`, or null. */
  estimateUnits(tx: DbTx, call: BillableCall, day: string): Promise<Units | null>;
  /** Inserts the event; false when `(job_type, job_id, call_seq)` already has one (nothing is changed then). */
  insertEvent(tx: DbTx, event: NewUsageEvent): Promise<boolean>;
  findReservation(tx: DbTx, jobType: JobType, jobId: string): Promise<ReservationRecord | null>;
  /** Inserts the reservation; false when the job already has one. */
  insertReservation(tx: DbTx, reservation: ReservationRecord): Promise<boolean>;
  /** Takes one call and its estimate off the reservation, deleting it when no call remains. False if there is none. */
  reduceReservation(tx: DbTx, jobType: JobType, jobId: string, units: Units): Promise<boolean>;
  deleteReservation(tx: DbTx, jobType: JobType, jobId: string): Promise<boolean>;
  totals(tx: DbTx, ownerId: string, dayStart: Date, monthStart: Date): Promise<SpendTotals>;
}

export interface PriceRepository {
  /** Upserts rows by their natural key; returns the number of rows in the file. */
  upsertPrices(tx: DbTx, rows: readonly PriceRow[]): Promise<number>;
}

export const USAGE_REPOSITORY = Symbol('USAGE_REPOSITORY');
export const USAGE_CONFIG = Symbol('USAGE_CONFIG');
export const USAGE_CLOCK = Symbol('USAGE_CLOCK');
export const USAGE_STARTUP = Symbol('USAGE_STARTUP');

export interface UsageConfig {
  /** `SPEND_CAP_DAILY_USD`, in ten-thousandths of a dollar. */
  readonly dailyCapUnits: Units;
  /** `SPEND_CAP_MONTHLY_USD`. */
  readonly monthlyCapUnits: Units;
}

export type Clock = () => Date;

export interface UsageStartupOptions {
  /** The billable operations this process is configured for (TD-D39). */
  readonly operations: readonly BillableCall[];
  readonly exit: (code: number) => void;
  readonly stderr: (line: string) => void;
}
