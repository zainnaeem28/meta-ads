import { and, desc, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { accessRequests, users } from '../../../database/schema/identity.js';
import type { DbTx } from '../../../platform/db/index.js';
import { normalizeEmail } from '../domain/records.js';
import type { AccessRequestState } from '../domain/records.js';

export const ACCESS_REQUEST_STORE = Symbol('ACCESS_REQUEST_STORE');

/** A transaction handle, or the pool-backed database for a single statement. */
export type AccessRequestDb = Pick<DbTx, 'select' | 'insert' | 'update' | 'execute'>;

export interface AccessRequestRow {
  readonly id: string;
  readonly idpSubject: string;
  readonly email: string;
  readonly note: string | null;
  readonly state: AccessRequestState;
  readonly decidedBy: string | null;
  readonly userId: string | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
}

export interface AccessRequestListRow extends AccessRequestRow {
  /** Full-precision `created_at` (microseconds), the keyset position of the list. */
  readonly createdAtText: string;
}

const COLUMNS = {
  id: accessRequests.id,
  idpSubject: accessRequests.idpSubject,
  email: accessRequests.email,
  note: accessRequests.note,
  state: accessRequests.state,
  decidedBy: accessRequests.decidedBy,
  userId: accessRequests.userId,
  decidedAt: accessRequests.decidedAt,
  createdAt: accessRequests.createdAt,
};

/** Persistence of API-002 and API-115..117. Every method takes the caller's transaction. */
export class AccessRequestAdminStore {
  /** One pending request per subject: `false` when one is already pending (the partial unique index). */
  async insertPending(
    db: AccessRequestDb,
    row: { id: string; idpSubject: string; email: string; note: string | null },
  ): Promise<boolean> {
    const rows = await db
      .insert(accessRequests)
      .values({ ...row, email: normalizeEmail(row.email) })
      .onConflictDoNothing()
      .returning({ id: accessRequests.id });
    return rows.length === 1;
  }

  async hasAccountForEmail(db: AccessRequestDb, email: string): Promise<boolean> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
      .limit(1);
    return rows.length === 1;
  }

  async findById(
    db: AccessRequestDb,
    id: string,
    lock = false,
  ): Promise<AccessRequestRow | undefined> {
    const query = db.select(COLUMNS).from(accessRequests).where(eq(accessRequests.id, id)).limit(1);
    const rows = await (lock ? query.for('update') : query);
    return rows[0] as AccessRequestRow | undefined;
  }

  /** The `users` row of the subject or of the email, if any (an approve must not create a second account). */
  async findAccount(
    db: AccessRequestDb,
    idpSubject: string,
    email: string,
  ): Promise<{ id: string; idpSubject: string } | undefined> {
    const rows = await db
      .select({ id: users.id, idpSubject: users.idpSubject })
      .from(users)
      .where(
        sql`(${users.idpSubject} = ${idpSubject} or lower(${users.email}) = ${normalizeEmail(email)})`,
      )
      .limit(1);
    return rows[0];
  }

  async insertUser(
    db: AccessRequestDb,
    row: { id: string; idpSubject: string; email: string },
  ): Promise<void> {
    await db.insert(users).values({
      id: row.id,
      idpSubject: row.idpSubject,
      email: normalizeEmail(row.email),
      role: 'user',
      linkedVia: 'access_request',
    });
  }

  /** `pending` → approved or declined, guarded by the current state. */
  async decide(
    db: AccessRequestDb,
    id: string,
    state: Exclude<AccessRequestState, 'pending'>,
    decidedBy: string,
    userId: string | null,
  ): Promise<boolean> {
    const rows = await db
      .update(accessRequests)
      .set({ state, decidedBy, userId, decidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(accessRequests.id, id), eq(accessRequests.state, 'pending')))
      .returning({ id: accessRequests.id });
    return rows.length === 1;
  }

  async list(
    db: AccessRequestDb,
    query: { state: AccessRequestState; limit: number; after?: { createdAt: string; id: string } },
  ): Promise<AccessRequestListRow[]> {
    const conditions: SQL[] = [eq(accessRequests.state, query.state)];
    if (query.after !== undefined) {
      conditions.push(
        sql`(${accessRequests.createdAt}, ${accessRequests.id}) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const rows = await db
      .select({ ...COLUMNS, createdAtText: sql<string>`${accessRequests.createdAt}::text` })
      .from(accessRequests)
      .where(and(...conditions))
      .orderBy(desc(accessRequests.createdAt), desc(accessRequests.id))
      .limit(query.limit + 1);
    return rows as AccessRequestListRow[];
  }
}

export type AccessRequestStorePort = {
  [K in keyof AccessRequestAdminStore]: AccessRequestAdminStore[K];
};
