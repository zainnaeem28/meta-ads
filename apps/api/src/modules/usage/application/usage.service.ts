import { Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE, lockXact } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { formatUsd, toDecimal, toUnits } from '../domain/money.js';
import type { Units } from '../domain/money.js';
import { PriceMissingError } from '../domain/types.js';
import type { BillableCall, CostBasis, JobType, UsageOutcome } from '../domain/types.js';
import { USAGE_CLOCK, USAGE_CONFIG, USAGE_REPOSITORY } from './ports.js';
import type { Clock, ReservationRecord, UsageConfig, UsageRepository } from './ports.js';

export interface ReserveInput {
  readonly ownerId: string;
  readonly jobType: JobType;
  readonly jobId: string;
  /** Every call the job may make, one entry each (a brief generation lists 2, a video 2: submit and its first QC). */
  readonly calls: readonly BillableCall[];
}

export interface Reservation {
  readonly id: string;
  readonly estimatedCostUsd: string;
  readonly remainingCalls: number;
  /** False when the job already had a reservation; it is returned unchanged and the cap is not checked again. */
  readonly created: boolean;
}

export interface CallInput {
  readonly ownerId: string;
  readonly call: BillableCall;
  readonly jobType: JobType;
  readonly jobId: string;
  readonly callSeq: number;
  readonly latencyMs?: number;
}

export interface RecordInput extends CallInput {
  /** `rejected` is the definitive, unbilled refusal: zero cost (SB-D9). */
  readonly outcome: Exclude<UsageOutcome, 'unconfirmed'>;
}

export interface SettleResult {
  /** False when the call already had its event: nothing was written and the reservation was not touched again. */
  readonly recorded: boolean;
  readonly costUsd: string;
}

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
const dayStart = (at: Date): Date => new Date(`${utcDay(at)}T00:00:00.000Z`);
const monthStart = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));

/**
 * The usage module's public service (ARCHITECTURE §5.9, SB v6 §4.2): the price lookup, the spend cap and the lifecycle
 * of one reservation and one event per provider call. Every method that changes state takes the caller's transaction and
 * the owner's `spend:{ownerId}` lock, so concurrent job creations of one owner queue here.
 */
@Injectable()
export class UsageService {
  private readonly log = new Logger('UsageService');

  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(USAGE_REPOSITORY) private readonly repository: UsageRepository,
    @Inject(USAGE_CONFIG) private readonly config: UsageConfig,
    @Inject(USAGE_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The estimate of one call in US dollars from the price row effective now. No row is a `PriceMissingError`; use
   * `estimateOrRefuse` where that must become the 503 of TD-D39.
   */
  async estimate(call: BillableCall, tx?: DbTx): Promise<string> {
    const units = await this.estimateUnits(call, tx);
    return toDecimal(units);
  }

  /** Same lookup; a missing row is logged as `price_missing` and refused as 503 `service_unavailable` (TD-D39). */
  async estimateOrRefuse(call: BillableCall, tx?: DbTx): Promise<string> {
    try {
      return await this.estimate(call, tx);
    } catch (error) {
      throw this.refusal(error);
    }
  }

  /** Throws `PriceMissingError` for the first call without a price row effective now (start-up check, TD-D39). */
  async assertPriced(calls: readonly BillableCall[]): Promise<void> {
    await this.database.uow.run(async (tx) => {
      for (const call of calls) await this.estimateUnits(call, tx);
    });
  }

  /**
   * Cap check (REQ-019): recorded estimates of the UTC day (and month) plus reservations plus the new estimate must not
   * exceed the daily (and monthly) cap, else 422 `spend_cap_reached` naming the limit and the estimate basis. Takes
   * the owner's spend lock, so it is only a decision while the caller's transaction is open.
   */
  async checkCap(tx: DbTx, ownerId: string, estimateUsd: string | number): Promise<void> {
    await lockXact(tx, 'spend', ownerId);
    const estimate = toUnits(estimateUsd);
    const now = this.clock();
    const totals = await this.repository.totals(tx, ownerId, dayStart(now), monthStart(now));
    const windows = [
      { code: 'daily', label: 'daily', cap: this.config.dailyCapUnits, spent: totals.dayUnits },
      {
        code: 'monthly',
        label: 'monthly',
        cap: this.config.monthlyCapUnits,
        spent: totals.monthUnits,
      },
    ] as const;
    for (const window of windows) {
      const total = window.spent + totals.reservedUnits + estimate;
      if (total <= window.cap) continue;
      throw new DomainError(
        'spend_cap_reached',
        `This would pass your ${window.label} spending limit of ${formatUsd(window.cap)}: ` +
          `${formatUsd(window.spent)} recorded and ${formatUsd(totals.reservedUnits)} reserved by running jobs ` +
          `plus ${formatUsd(estimate)} for this one, all estimates from the price table.`,
        [
          {
            field: 'limit',
            code: window.code,
            message: `${formatUsd(window.cap)} per ${window.code === 'daily' ? 'UTC day' : 'UTC month'}`,
          },
          {
            field: 'estimateBasis',
            code: 'price_table',
            message: `recorded ${formatUsd(window.spent)} + reserved ${formatUsd(totals.reservedUnits)} + new ${formatUsd(estimate)}`,
          },
        ],
      );
    }
  }

  /**
   * Job creation (ARCHITECTURE §5.9): sums the estimates of the job's calls, checks the cap and inserts the reservation,
   * all under the owner's spend lock in the caller's transaction (the job row goes in the same commit). Idempotent per
   * job: a second call returns the existing reservation. A call with no price row is 503 and nothing is written.
   */
  async reserve(tx: DbTx, input: ReserveInput): Promise<Reservation> {
    if (input.calls.length < 1) throw new RangeError('a reservation needs at least one call');
    await lockXact(tx, 'spend', input.ownerId);
    const existing = await this.repository.findReservation(tx, input.jobType, input.jobId);
    if (existing !== null) return this.reservationOf(existing, false);
    let total: Units = 0;
    try {
      for (const call of input.calls) total += await this.estimateUnits(call, tx);
    } catch (error) {
      throw this.refusal(error);
    }
    await this.checkCap(tx, input.ownerId, toDecimal(total));
    const reservation: ReservationRecord = {
      id: newId(),
      ownerId: input.ownerId,
      jobType: input.jobType,
      jobId: input.jobId,
      estimatedUnits: total,
      remainingCalls: input.calls.length,
    };
    await this.repository.insertReservation(tx, reservation);
    return this.reservationOf(reservation, true);
  }

  /**
   * One provider call has returned (SB-D9): writes its usage event and takes the call's estimate off the job's
   * reservation, in this transaction. A success or failure records the estimate; a definitive unbilled rejection records
   * zero. Idempotent per `(jobType, jobId, callSeq)`: a repeat changes nothing.
   */
  async record(tx: DbTx, input: RecordInput): Promise<SettleResult> {
    const rejected = input.outcome === 'rejected';
    return this.settle(tx, input, input.outcome, rejected ? 'zero_rejected' : 'estimate');
  }

  /**
   * The outcome of a call is unknown (5xx or timeout after sending, an orphaned `submitting`, a cancel while
   * `submitting`): the reservation part becomes an `unconfirmed` event that keeps the estimate counted, in the same
   * transaction. A late provider response finds the event and does nothing. Idempotent like `record`.
   */
  async convertUnconfirmed(tx: DbTx, input: CallInput): Promise<SettleResult> {
    return this.settle(tx, input, 'unconfirmed', 'unconfirmed_estimate');
  }

  /** The job ended before a call (cancelled or failed while `pending`, or terminal): deletes its reservation. */
  async release(
    tx: DbTx,
    input: { ownerId: string; jobType: JobType; jobId: string },
  ): Promise<boolean> {
    await lockXact(tx, 'spend', input.ownerId);
    return this.repository.deleteReservation(tx, input.jobType, input.jobId);
  }

  private async settle(
    tx: DbTx,
    input: CallInput,
    outcome: UsageOutcome,
    costBasis: CostBasis,
  ): Promise<SettleResult> {
    if (!Number.isInteger(input.callSeq) || input.callSeq < 1)
      throw new RangeError('callSeq starts at 1');
    await lockXact(tx, 'spend', input.ownerId);
    // Throws PriceMissingError: a call was made with no price in force, which the start-up check rules out; fail loudly.
    const estimate = await this.estimateUnits(input.call, tx);
    const cost = costBasis === 'zero_rejected' ? 0 : estimate;
    const inserted = await this.repository.insertEvent(tx, {
      id: newId(),
      ownerId: input.ownerId,
      call: input.call,
      jobType: input.jobType,
      jobId: input.jobId,
      callSeq: input.callSeq,
      outcome,
      costUnits: cost,
      costBasis,
      latencyMs: input.latencyMs ?? null,
      at: this.clock(),
    });
    if (!inserted) return { recorded: false, costUsd: toDecimal(cost) };
    await this.repository.reduceReservation(tx, input.jobType, input.jobId, estimate);
    return { recorded: true, costUsd: toDecimal(cost) };
  }

  private async estimateUnits(call: BillableCall, tx?: DbTx): Promise<Units> {
    const read = async (t: DbTx): Promise<Units> => {
      const units = await this.repository.estimateUnits(t, call, utcDay(this.clock()));
      if (units === null) throw new PriceMissingError(call);
      return units;
    };
    return tx === undefined ? this.database.uow.run(read) : read(tx);
  }

  private reservationOf(record: ReservationRecord, created: boolean): Reservation {
    return {
      id: record.id,
      estimatedCostUsd: toDecimal(record.estimatedUnits),
      remainingCalls: record.remainingCalls,
      created,
    };
  }

  /** Maps a missing price to the 503 of TD-D39 and logs it naming the provider and operation; other errors pass. */
  private refusal(error: unknown): unknown {
    if (!(error instanceof PriceMissingError)) return error;
    this.log.error({
      msg: 'price_missing',
      event: 'price_missing',
      provider: error.call.provider,
      operation: error.call.operation,
    });
    return new DomainError(
      'service_unavailable',
      'The service is temporarily unavailable. Try again shortly.',
    );
  }
}
