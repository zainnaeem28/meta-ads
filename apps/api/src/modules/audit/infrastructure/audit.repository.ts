import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { adminAlerts, auditEvents } from '../../../database/schema/audit.js';
import type {
  AlertPosition,
  AlertQuery,
  AlertRecord,
  AuditEventInput,
  AuditRepository,
  Executor,
} from '../application/ports.js';
import type { AlertKind } from '../domain/catalogue.js';

type AlertRow = typeof adminAlerts.$inferSelect;

function toRecord(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    kind: row.kind as AlertKind,
    subjectUserId: row.subjectUserId,
    counts: row.counts as Record<string, number>,
    raisedAt: row.raisedAt,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedBy: row.acknowledgedBy,
  };
}

/** Rows strictly after `after` in the order (acknowledged_at nulls first, raised_at desc, id desc). */
function afterPosition(after: AlertPosition): SQL {
  const olderOpen = sql`(${adminAlerts.raisedAt}, ${adminAlerts.id}) < (${after.raisedAt}::timestamptz, ${after.id}::uuid)`;
  if (after.acknowledgedAt === null) {
    return or(
      and(isNull(adminAlerts.acknowledgedAt), olderOpen),
      isNotNull(adminAlerts.acknowledgedAt),
    ) as SQL;
  }
  return and(
    isNotNull(adminAlerts.acknowledgedAt),
    or(
      sql`${adminAlerts.acknowledgedAt} > ${after.acknowledgedAt}::timestamptz`,
      and(sql`${adminAlerts.acknowledgedAt} = ${after.acknowledgedAt}::timestamptz`, olderOpen),
    ),
  ) as SQL;
}

export class DrizzleAuditRepository implements AuditRepository {
  async insertEvent(db: Executor, id: string, event: AuditEventInput): Promise<void> {
    await db.insert(auditEvents).values({
      id,
      actorId: event.actorId,
      actorType: event.actorType,
      action: event.action,
      objectType: event.objectType,
      objectId: event.objectId,
      outcome: event.outcome,
      requestId: event.requestId ?? null,
    });
  }

  async insertAlert(
    db: Executor,
    alert: Parameters<AuditRepository['insertAlert']>[1],
  ): Promise<boolean> {
    const rows = await db
      .insert(adminAlerts)
      .values(alert)
      .onConflictDoNothing()
      .returning({ id: adminAlerts.id });
    return rows.length === 1;
  }

  async listAlerts(db: Executor, query: AlertQuery): Promise<AlertRecord[]> {
    const filters: SQL[] = [];
    if (query.acknowledged === false) filters.push(isNull(adminAlerts.acknowledgedAt));
    if (query.acknowledged === true) filters.push(isNotNull(adminAlerts.acknowledgedAt));
    if (query.after !== undefined) filters.push(afterPosition(query.after));
    const rows = await db
      .select()
      .from(adminAlerts)
      .where(and(...filters))
      .orderBy(
        sql`${adminAlerts.acknowledgedAt} asc nulls first`,
        desc(adminAlerts.raisedAt),
        desc(adminAlerts.id),
      )
      .limit(query.limit);
    return rows.map(toRecord);
  }

  async acknowledge(db: Executor, id: string, by: string): Promise<AlertRecord | null> {
    const rows = await db
      .update(adminAlerts)
      .set({ acknowledgedAt: sql`now()`, acknowledgedBy: by })
      .where(and(eq(adminAlerts.id, id), isNull(adminAlerts.acknowledgedAt)))
      .returning();
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async findAlert(db: Executor, id: string): Promise<AlertRecord | null> {
    const rows = await db.select().from(adminAlerts).where(eq(adminAlerts.id, id));
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }
}
