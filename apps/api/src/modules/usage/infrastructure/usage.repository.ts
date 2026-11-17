import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../platform/db/index.js';
import { toDecimal, toUnits } from '../domain/money.js';
import type { Units } from '../domain/money.js';
import type { BillableCall, JobType, PriceRow } from '../domain/types.js';
import type {
  NewUsageEvent,
  PriceRepository,
  ReservationRecord,
  SpendTotals,
  UsageRepository,
} from '../application/ports.js';

const first = <T>(result: { rows: T[] }): T | undefined => result.rows[0];

export class DrizzleUsageRepository implements UsageRepository, PriceRepository {
  async estimateUnits(tx: DbTx, call: BillableCall, day: string): Promise<Units | null> {
    const row = first(
      await tx.execute<{ estimate: string }>(sql`
        select round(unit_price_usd * units_per_call, 4)::text as estimate
          from price_table
         where provider = ${call.provider} and operation = ${call.operation} and effective_from <= ${day}::date
         order by effective_from desc
         limit 1`),
    );
    return row === undefined ? null : toUnits(row.estimate);
  }

  async insertEvent(tx: DbTx, event: NewUsageEvent): Promise<boolean> {
    const result = await tx.execute(sql`
      insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome,
                                estimated_cost_usd, cost_basis, latency_ms, at)
      values (${event.id}, ${event.ownerId}, ${event.call.provider}, ${event.call.operation}, ${event.jobType},
              ${event.jobId}, ${event.callSeq}, ${event.outcome}, ${toDecimal(event.costUnits)}::numeric,
              ${event.costBasis}, ${event.latencyMs}, ${event.at.toISOString()}::timestamptz)
      on conflict (job_type, job_id, call_seq) do nothing
      returning id`);
    return result.rows.length === 1;
  }

  async findReservation(
    tx: DbTx,
    jobType: JobType,
    jobId: string,
  ): Promise<ReservationRecord | null> {
    const row = first(
      await tx.execute<{
        id: string;
        owner_id: string;
        estimate: string;
        remaining_calls: number;
      }>(sql`
        select id, owner_id, estimated_cost_usd::text as estimate, remaining_calls
          from spend_reservations
         where job_type = ${jobType} and job_id = ${jobId}`),
    );
    return row === undefined
      ? null
      : {
          id: row.id,
          ownerId: row.owner_id,
          jobType,
          jobId,
          estimatedUnits: toUnits(row.estimate),
          remainingCalls: Number(row.remaining_calls),
        };
  }

  async insertReservation(tx: DbTx, reservation: ReservationRecord): Promise<boolean> {
    const result = await tx.execute(sql`
      insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls)
      values (${reservation.id}, ${reservation.ownerId}, ${reservation.jobType}, ${reservation.jobId},
              ${toDecimal(reservation.estimatedUnits)}::numeric, ${reservation.remainingCalls})
      on conflict (job_type, job_id) do nothing
      returning id`);
    return result.rows.length === 1;
  }

  async reduceReservation(
    tx: DbTx,
    jobType: JobType,
    jobId: string,
    units: Units,
  ): Promise<boolean> {
    const deleted = await tx.execute(sql`
      delete from spend_reservations
       where job_type = ${jobType} and job_id = ${jobId} and remaining_calls <= 1
       returning id`);
    if (deleted.rows.length === 1) return true;
    const updated = await tx.execute(sql`
      update spend_reservations
         set estimated_cost_usd = greatest(estimated_cost_usd - ${toDecimal(units)}::numeric, 0),
             remaining_calls = remaining_calls - 1
       where job_type = ${jobType} and job_id = ${jobId}
       returning id`);
    return updated.rows.length === 1;
  }

  async deleteReservation(tx: DbTx, jobType: JobType, jobId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      delete from spend_reservations where job_type = ${jobType} and job_id = ${jobId} returning id`);
    return result.rows.length === 1;
  }

  async totals(tx: DbTx, ownerId: string, dayStart: Date, monthStart: Date): Promise<SpendTotals> {
    const spent = first(
      await tx.execute<{ day: string; month: string }>(sql`
        select coalesce(sum(estimated_cost_usd) filter (where at >= ${dayStart.toISOString()}::timestamptz), 0)::text as day,
               coalesce(sum(estimated_cost_usd), 0)::text as month
          from usage_events
         where owner_id = ${ownerId} and at >= ${monthStart.toISOString()}::timestamptz`),
    );
    const reserved = first(
      await tx.execute<{ total: string }>(sql`
        select coalesce(sum(estimated_cost_usd), 0)::text as total from spend_reservations where owner_id = ${ownerId}`),
    );
    return {
      dayUnits: toUnits(spent?.day ?? '0'),
      monthUnits: toUnits(spent?.month ?? '0'),
      reservedUnits: toUnits(reserved?.total ?? '0'),
    };
  }

  async upsertPrices(tx: DbTx, rows: readonly PriceRow[]): Promise<number> {
    for (const row of rows) {
      await tx.execute(sql`
        insert into price_table (provider, operation, effective_from, unit, unit_price_usd, units_per_call)
        values (${row.provider}, ${row.operation}, ${row.effectiveFrom}::date, ${row.unit},
                ${row.unitPriceUsd}::numeric, ${row.unitsPerCall}::numeric)
        on conflict (provider, operation, effective_from)
        do update set unit = excluded.unit, unit_price_usd = excluded.unit_price_usd,
                      units_per_call = excluded.units_per_call`);
    }
    return rows.length;
  }
}
