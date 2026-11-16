import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../../../platform/db/index.js';
import {
  accessRequests,
  invitations,
  platformSettings,
  users,
} from '../../../database/schema/identity.js';
import { normalizeEmail } from '../domain/records.js';
import type {
  AccessRequestState,
  InvitationState,
  LinkedVia,
  Role,
  SendState,
  SignupMode,
  UserStatus,
} from '../domain/records.js';

/** A transaction handle, or the pool-backed database for a single statement. */
export type Executor = Pick<DbTx, 'select' | 'insert' | 'update'>;

export type UserRow = typeof users.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;
export type AccessRequestRow = typeof accessRequests.$inferSelect;
export type SettingsRow = typeof platformSettings.$inferSelect;

// Module-private repositories (ARCHITECTURE §1.3): only the identity services use them, every method takes the
// caller's transaction, and every update stamps `updated_at` (there is no trigger).

export class UserRepository {
  async findBySubject(db: Executor, idpSubject: string): Promise<UserRow | undefined> {
    const rows = await db.select().from(users).where(eq(users.idpSubject, idpSubject)).limit(1);
    return rows[0];
  }

  async findById(db: Executor, id: string): Promise<UserRow | undefined> {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0];
  }

  /** Inserts the row; `undefined` when the subject already has one (the concurrent first token lost the race). */
  async insertIfAbsent(
    db: Executor,
    user: {
      id: string;
      idpSubject: string;
      email: string;
      role?: Role;
      linkedVia: LinkedVia;
    },
  ): Promise<UserRow | undefined> {
    const rows = await db
      .insert(users)
      .values({ ...user, email: normalizeEmail(user.email) })
      .onConflictDoNothing({ target: users.idpSubject })
      .returning();
    return rows[0];
  }

  /** Optimistic update: `undefined` when `expectedVersion` is stale. */
  async setStatus(
    db: Executor,
    id: string,
    expectedVersion: number,
    status: UserStatus,
  ): Promise<UserRow | undefined> {
    const rows = await db
      .update(users)
      .set({
        status,
        statusChangedAt: sql`now()`,
        version: sql`${users.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(users.id, id), eq(users.version, expectedVersion)))
      .returning();
    return rows[0];
  }

  async setRole(
    db: Executor,
    id: string,
    expectedVersion: number,
    role: Role,
  ): Promise<UserRow | undefined> {
    const rows = await db
      .update(users)
      .set({ role, version: sql`${users.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(users.id, id), eq(users.version, expectedVersion)))
      .returning();
    return rows[0];
  }

  async countActiveAdmins(db: Executor): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
    return rows[0]?.n ?? 0;
  }
}

export class InvitationRepository {
  /** One `invited` row per email: `undefined` when another one exists (the caller answers 202 with the same body). */
  async insertInvited(
    db: Executor,
    invitation: { id: string; email: string; invitedBy: string | null; expiresAt: Date },
  ): Promise<InvitationRow | undefined> {
    const rows = await db
      .insert(invitations)
      .values({ ...invitation, email: normalizeEmail(invitation.email) })
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  async findInvitedByEmail(db: Executor, email: string): Promise<InvitationRow | undefined> {
    const rows = await db
      .select()
      .from(invitations)
      .where(
        and(
          sql`lower(${invitations.email}) = ${normalizeEmail(email)}`,
          eq(invitations.state, 'invited'),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async findById(db: Executor, id: string): Promise<InvitationRow | undefined> {
    const rows = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
    return rows[0];
  }

  /** `pending` → `sent` with the provider's id (conditional: a sweep may have marked it `send_failed`). */
  async markSent(db: Executor, id: string, idpInvitationId: string): Promise<boolean> {
    const rows = await db
      .update(invitations)
      .set({ sendState: 'sent', idpInvitationId, updatedAt: sql`now()` })
      .where(and(eq(invitations.id, id), eq(invitations.sendState, 'pending')))
      .returning({ id: invitations.id });
    return rows.length === 1;
  }

  async markSendFailed(db: Executor, id: string): Promise<boolean> {
    const rows = await db
      .update(invitations)
      .set({ sendState: 'send_failed', updatedAt: sql`now()` })
      .where(and(eq(invitations.id, id), eq(invitations.sendState, 'pending')))
      .returning({ id: invitations.id });
    return rows.length === 1;
  }

  /** `invited` → `to`, guarded by the current state. */
  async transition(
    db: Executor,
    id: string,
    to: Exclude<InvitationState, 'invited'>,
    acceptedUserId: string | null = null,
  ): Promise<boolean> {
    const rows = await db
      .update(invitations)
      .set({
        state: to,
        acceptedUserId: to === 'accepted' ? acceptedUserId : null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(invitations.id, id), eq(invitations.state, 'invited')))
      .returning({ id: invitations.id });
    return rows.length === 1;
  }

  async sendStateOf(db: Executor, id: string): Promise<SendState | undefined> {
    const row = await this.findById(db, id);
    return row?.sendState as SendState | undefined;
  }
}

export class AccessRequestRepository {
  /** One pending request per subject: `undefined` when one is already pending. */
  async insertPending(
    db: Executor,
    request: { id: string; idpSubject: string; email: string; note: string | null },
  ): Promise<AccessRequestRow | undefined> {
    const rows = await db
      .insert(accessRequests)
      .values({ ...request, email: normalizeEmail(request.email) })
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  async findById(db: Executor, id: string): Promise<AccessRequestRow | undefined> {
    const rows = await db.select().from(accessRequests).where(eq(accessRequests.id, id)).limit(1);
    return rows[0];
  }

  /** `pending` → approved or declined; `undefined` when the request was already decided. */
  async decide(
    db: Executor,
    id: string,
    state: Exclude<AccessRequestState, 'pending'>,
    decidedBy: string,
    userId: string | null,
  ): Promise<AccessRequestRow | undefined> {
    const rows = await db
      .update(accessRequests)
      .set({ state, decidedBy, userId, decidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(accessRequests.id, id), eq(accessRequests.state, 'pending')))
      .returning();
    return rows[0];
  }
}

export class SettingsRepository {
  /** The single row, created with its defaults on first use (the seed does the same). */
  async get(db: Executor): Promise<SettingsRow> {
    await db.insert(platformSettings).values({ id: 1 }).onConflictDoNothing();
    const rows = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
    return rows[0] as SettingsRow;
  }

  /** Sets the marker once; `false` when it is already set (the first admin is seeded only once). */
  async markFirstAdminSeeded(db: Executor): Promise<boolean> {
    await db.insert(platformSettings).values({ id: 1 }).onConflictDoNothing();
    const rows = await db
      .update(platformSettings)
      .set({ firstAdminSeededAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(platformSettings.id, 1), sql`${platformSettings.firstAdminSeededAt} is null`))
      .returning({ id: platformSettings.id });
    return rows.length === 1;
  }

  /** Optimistic update of the signup mode; `undefined` when `expectedVersion` is stale. */
  async setSignupMode(
    db: Executor,
    expectedVersion: number,
    mode: SignupMode,
    updatedBy: string | null,
  ): Promise<SettingsRow | undefined> {
    const rows = await db
      .update(platformSettings)
      .set({
        signupMode: mode,
        updatedBy,
        version: sql`${platformSettings.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(platformSettings.id, 1), eq(platformSettings.version, expectedVersion)))
      .returning();
    return rows[0];
  }
}
