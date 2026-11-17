import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { invitations, users } from '../../../database/schema/identity.js';
import type { DbTx } from '../../../platform/db/index.js';
import { normalizeEmail } from '../domain/records.js';
import type { InvitationState, SendState } from '../domain/records.js';

export const INVITATION_ADMIN_STORE = Symbol('INVITATION_ADMIN_STORE');

/** A transaction handle, or the pool-backed database for a single statement. */
export type InvitationDb = Pick<DbTx, 'select' | 'insert' | 'update' | 'execute'>;

export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly invitedBy: string | null;
  readonly state: InvitationState;
  readonly sendState: SendState;
  readonly idpInvitationId: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InvitationListRow extends InvitationRow {
  /** Full-precision `created_at` (microseconds), the keyset position of the list. */
  readonly createdAtText: string;
}

export interface ListQuery {
  /** `expired` includes the `invited` rows whose expiry has passed (computed at read, persisted by the job). */
  readonly state?: InvitationState;
  readonly limit: number;
  readonly after?: { readonly createdAt: string; readonly id: string };
}

const COLUMNS = {
  id: invitations.id,
  email: invitations.email,
  invitedBy: invitations.invitedBy,
  state: invitations.state,
  sendState: invitations.sendState,
  idpInvitationId: invitations.idpInvitationId,
  expiresAt: invitations.expiresAt,
  createdAt: invitations.createdAt,
  updatedAt: invitations.updatedAt,
};

/**
 * Persistence of the invitation operations (API-110..113 and the expiry job). Every method takes the caller's
 * transaction; every update stamps `updated_at` (there is no trigger). `idp_invitation_id` is the provider's handle
 * and never leaves the module: a `revoked` or `expired` row that still has one is a provider revoke owed (the job
 * retries it, then clears the column).
 */
export class InvitationAdminStore {
  /** Serializes the invite, replace and resend decisions of one address. */
  async lockEmail(db: InvitationDb, email: string): Promise<void> {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`invitation-email:${normalizeEmail(email)}`}, 0))`,
    );
  }

  async hasAccount(db: InvitationDb, email: string): Promise<boolean> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
      .limit(1);
    return rows.length === 1;
  }

  async findById(db: InvitationDb, id: string, lock = false): Promise<InvitationRow | undefined> {
    const query = db.select(COLUMNS).from(invitations).where(eq(invitations.id, id)).limit(1);
    const rows = await (lock ? query.for('update') : query);
    return rows[0] as InvitationRow | undefined;
  }

  /** Revokes the `invited` row of the address (replaced by a new invite); returns it with its provider handle. */
  async revokeInvitedByEmail(db: InvitationDb, email: string): Promise<InvitationRow | undefined> {
    const rows = await db
      .update(invitations)
      .set({ state: 'revoked', updatedAt: sql`now()` })
      .where(
        and(
          sql`lower(${invitations.email}) = ${normalizeEmail(email)}`,
          eq(invitations.state, 'invited'),
        ),
      )
      .returning(COLUMNS);
    return rows[0] as InvitationRow | undefined;
  }

  async insertInvited(
    db: InvitationDb,
    row: { id: string; email: string; invitedBy: string; expiresAt: Date },
  ): Promise<void> {
    await db.insert(invitations).values({ ...row, email: normalizeEmail(row.email) });
  }

  /** `invited` → `revoked`, guarded by the current state. */
  async revoke(db: InvitationDb, id: string): Promise<boolean> {
    const rows = await db
      .update(invitations)
      .set({ state: 'revoked', updatedAt: sql`now()` })
      .where(and(eq(invitations.id, id), eq(invitations.state, 'invited')))
      .returning({ id: invitations.id });
    return rows.length === 1;
  }

  /** `invited` → `expired`, guarded by the state and by the expiry itself. */
  async expire(db: InvitationDb, id: string): Promise<boolean> {
    const rows = await db
      .update(invitations)
      .set({ state: 'expired', updatedAt: sql`now()` })
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.state, 'invited'),
          lt(invitations.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: invitations.id });
    return rows.length === 1;
  }

  /** Resend: the send starts again (`pending`) and the expiry restarts. */
  async restart(db: InvitationDb, id: string, expiresAt: Date): Promise<boolean> {
    const rows = await db
      .update(invitations)
      .set({ sendState: 'pending', expiresAt, updatedAt: sql`now()` })
      .where(and(eq(invitations.id, id), eq(invitations.state, 'invited')))
      .returning({ id: invitations.id });
    return rows.length === 1;
  }

  /** `pending` → `sent` with the provider's handle; conditional, so a stale sweep or a revoke wins over a late answer. */
  async markSent(db: InvitationDb, id: string, idpInvitationId: string): Promise<boolean> {
    const rows = await db
      .update(invitations)
      .set({ sendState: 'sent', idpInvitationId, updatedAt: sql`now()` })
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.sendState, 'pending'),
          eq(invitations.state, 'invited'),
        ),
      )
      .returning({ id: invitations.id });
    return rows.length === 1;
  }

  /** `pending` → `send_failed`; `clearHandle` after the old provider invitation was revoked (a resend that then failed). */
  async markSendFailed(db: InvitationDb, id: string, clearHandle = false): Promise<boolean> {
    const rows = await db
      .update(invitations)
      .set({
        sendState: 'send_failed',
        ...(clearHandle ? { idpInvitationId: null } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.sendState, 'pending'),
          eq(invitations.state, 'invited'),
        ),
      )
      .returning({ id: invitations.id });
    return rows.length === 1;
  }

  /** The provider revoke is done (or the provider never knew the invitation): nothing is owed any more. */
  async clearHandle(db: InvitationDb, id: string, handle: string): Promise<void> {
    await db
      .update(invitations)
      .set({ idpInvitationId: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.idpInvitationId, handle),
          inArray(invitations.state, ['revoked', 'expired']),
        ),
      );
  }

  async list(db: InvitationDb, query: ListQuery): Promise<InvitationListRow[]> {
    const conditions: SQL[] = [];
    const expired = sql`${invitations.state} = 'invited' and ${invitations.expiresAt} <= now()`;
    if (query.state === 'expired') {
      conditions.push(sql`(${invitations.state} = 'expired' or (${expired}))`);
    } else if (query.state === 'invited') {
      conditions.push(sql`(${invitations.state} = 'invited' and ${invitations.expiresAt} > now())`);
    } else if (query.state !== undefined) {
      conditions.push(eq(invitations.state, query.state));
    }
    if (query.after !== undefined) {
      conditions.push(
        sql`(${invitations.createdAt}, ${invitations.id}) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const rows = await db
      .select({ ...COLUMNS, createdAtText: sql<string>`${invitations.createdAt}::text` })
      .from(invitations)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(invitations.createdAt), desc(invitations.id))
      .limit(query.limit + 1);
    return rows as InvitationListRow[];
  }

  /** `invited` rows past their expiry (the job expires them). */
  async dueForExpiry(db: InvitationDb, limit: number): Promise<string[]> {
    const rows = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.state, 'invited'), lt(invitations.expiresAt, sql`now()`)))
      .orderBy(invitations.expiresAt)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** `pending` sends untouched for `staleMinutes` (the api died, or the provider never answered) become `send_failed`. */
  async failStaleSends(db: InvitationDb, staleMinutes: number): Promise<number> {
    const rows = await db
      .update(invitations)
      .set({ sendState: 'send_failed', updatedAt: sql`now()` })
      .where(
        and(
          eq(invitations.sendState, 'pending'),
          eq(invitations.state, 'invited'),
          sql`${invitations.updatedAt} < now() - make_interval(mins => ${staleMinutes})`,
        ),
      )
      .returning({ id: invitations.id });
    return rows.length;
  }

  /** Closed rows that still hold a provider handle: the provider revoke is owed. */
  async revokesOwed(db: InvitationDb, limit: number): Promise<{ id: string; handle: string }[]> {
    const rows = await db
      .select({ id: invitations.id, handle: invitations.idpInvitationId })
      .from(invitations)
      .where(
        and(
          inArray(invitations.state, ['revoked', 'expired']),
          isNotNull(invitations.idpInvitationId),
        ),
      )
      .orderBy(invitations.updatedAt)
      .limit(limit);
    return rows.map((row) => ({ id: row.id, handle: row.handle as string }));
  }
}

/** The operations the invitation service and job use; a unit test substitutes an in-memory implementation. */
export type InvitationAdminStorePort = {
  [K in keyof InvitationAdminStore]: InvitationAdminStore[K];
};
