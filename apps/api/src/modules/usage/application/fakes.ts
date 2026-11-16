import { UnitOfWork } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import type { Units } from '../domain/money.js';
import type { BillableCall, JobType } from '../domain/types.js';
import type {
  NewUsageEvent,
  ReservationRecord,
  SpendTotals,
  UsageRepository,
} from './ports.js';

/** Test-only in-memory repository and unit of work; the SQL one is proven on PostgreSQL by usage.integration.test.ts. */
export class FakeUsageRepository implements UsageRepository {
  prices = new Map<string, Units>();
  events: NewUsageEvent[] = [];
  reservations: ReservationRecord[] = [];
  totalsArgs: { dayStart: Date; monthStart: Date }[] = [];
  totalsOverride: SpendTotals | undefined;

  setPrice(call: BillableCall, units: Units): void {
    this.prices.set(`${call.provider}|${call.operation}`, units);
  }

  estimateUnits(_tx: DbTx, call: BillableCall): Promise<Units | null> {
    return Promise.resolve(this.prices.get(`${call.provider}|${call.operation}`) ?? null);
  }

  insertEvent(_tx: DbTx, event: NewUsageEvent): Promise<boolean> {
    const dup = this.events.some(
      (e) => e.jobType === event.jobType && e.jobId === event.jobId && e.callSeq === event.callSeq,
    );
    if (!dup) this.events.push(event);
    return Promise.resolve(!dup);
  }

  findReservation(_tx: DbTx, jobType: JobType, jobId: string): Promise<ReservationRecord | null> {
    return Promise.resolve(this.reservations.find((r) => r.jobType === jobType && r.jobId === jobId) ?? null);
  }

  insertReservation(_tx: DbTx, reservation: ReservationRecord): Promise<boolean> {
    this.reservations.push(reservation);
    return Promise.resolve(true);
  }

  reduceReservation(_tx: DbTx, jobType: JobType, jobId: string, units: Units): Promise<boolean> {
    const index = this.reservations.findIndex((r) => r.jobType === jobType && r.jobId === jobId);
    const found = this.reservations[index];
    if (found === undefined) return Promise.resolve(false);
    if (found.remainingCalls <= 1) this.reservations.splice(index, 1);
    else {
      this.reservations[index] = {
        ...found,
        estimatedUnits: Math.max(0, found.estimatedUnits - units),
        remainingCalls: found.remainingCalls - 1,
      };
    }
    return Promise.resolve(true);
  }

  deleteReservation(_tx: DbTx, jobType: JobType, jobId: string): Promise<boolean> {
    const before = this.reservations.length;
    this.reservations = this.reservations.filter((r) => !(r.jobType === jobType && r.jobId === jobId));
    return Promise.resolve(this.reservations.length < before);
  }

  totals(_tx: DbTx, ownerId: string, dayStart: Date, monthStart: Date): Promise<SpendTotals> {
    this.totalsArgs.push({ dayStart, monthStart });
    if (this.totalsOverride !== undefined) return Promise.resolve(this.totalsOverride);
    const mine = this.events.filter((e) => e.ownerId === ownerId);
    const sum = (list: NewUsageEvent[]): number => list.reduce((n, e) => n + e.costUnits, 0);
    return Promise.resolve({
      dayUnits: sum(mine.filter((e) => e.at >= dayStart)),
      monthUnits: sum(mine.filter((e) => e.at >= monthStart)),
      reservedUnits: this.reservations
        .filter((r) => r.ownerId === ownerId)
        .reduce((n, r) => n + r.estimatedUnits, 0),
    });
  }
}

/** A unit of work over a fake transaction that records the locks taken (the SQL runs on PostgreSQL in the integration test). */
export function fakeDatabase(): { database: Pick<Database, 'uow'>; executed: string[] } {
  const executed: string[] = [];
  const tx = {
    execute: (query: { queryChunks?: unknown[] }) => {
      executed.push(JSON.stringify(query.queryChunks ?? []));
      return Promise.resolve({ rows: [] });
    },
  } as unknown as DbTx;
  const database = { uow: new UnitOfWork({ transaction: (fn) => fn(tx) }) } as unknown as Pick<Database, 'uow'>;
  return { database, executed };
}
