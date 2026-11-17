import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { briefJobs } from '../../../database/schema/brief.js';
import { campaigns } from '../../../database/schema/campaigns.js';
import { accessRequests, invitations, users } from '../../../database/schema/identity.js';
import { deletionRuns } from '../../../database/schema/lifecycle.js';
import { keyEvents, providerKeys } from '../../../database/schema/provider-keys.js';
import { lockXact } from '../../../platform/db/index.js';
import type { DbTx } from '../../../platform/db/index.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import type {
  AccountLifecycleRepository,
  AccountRun,
  AccountRunListed,
  AccountRunQuery,
  AccountStatus,
  AccountSubject,
} from '../application/account-lifecycle-ports.js';
import type { CancelledBriefJob } from '../application/campaign-deletion-ports.js';

const BRIEF_NON_TERMINAL = ['pending', 'submitting', 'submitted', 'processing'];

function runOf(row: typeof deletionRuns.$inferSelect): AccountRun & { createdAt: string; notBefore: string; ownerId: string } {
  return {
    id: row.id,
    subjectId: row.subjectId,
    ownerId: row.ownerId,
    step: row.step,
    state: row.state as AccountRun['state'],
    attempts: row.attempts,
    remainingObjects: row.remainingObjects,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    notBefore: row.notBefore,
  };
}

/**
 * Drizzle adapter of the account run and of the statements the removal makes on other modules' tables, all inside the
 * caller's transaction (the same pattern as the campaign run's repository).
 */
export class DrizzleAccountLifecycleRepository implements AccountLifecycleRepository {
  async lockAndFind(tx: DbTx, userId: string): Promise<AccountSubject | undefined> {
    await lockXact(tx, 'admin-invariant');
    const [row] = await tx
      .select({
        id: users.id,
        email: users.email,
        idpSubject: users.idpSubject,
        role: users.role,
        status: users.status,
        version: users.version,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (row === undefined) return undefined;
    return {
      id: row.id,
      email: row.email,
      idpSubject: row.idpSubject,
      role: row.role === 'admin' ? 'admin' : 'user',
      status: row.status as AccountStatus,
      version: row.version,
    };
  }

  async cancelBriefJobs(
    tx: DbTx,
    ownerId: string,
    cause: 'cancelled_account_suspended' | 'cancelled_account_removed',
  ): Promise<CancelledBriefJob[]> {
    const live = await tx
      .select({ id: briefJobs.id, state: briefJobs.state, callCount: briefJobs.callCount })
      .from(briefJobs)
      .where(and(eq(briefJobs.ownerId, ownerId), inArray(briefJobs.state, BRIEF_NON_TERMINAL)))
      .for('update');
    if (live.length === 0) return [];
    await tx
      .update(briefJobs)
      .set({
        state: 'cancelled',
        causeClass: cause,
        causeMessage: cause === 'cancelled_account_removed' ? 'The account was removed.' : 'The account was suspended.',
        updatedAt: sql`now()`,
      })
      .where(inArray(briefJobs.id, live.map((job) => job.id)));
    return live;
  }

  async deleteKeys(tx: DbTx, ownerId: string): Promise<number> {
    const removed = await tx
      .delete(providerKeys)
      .where(eq(providerKeys.ownerId, ownerId))
      .returning({ id: providerKeys.id, provider: providerKeys.provider });
    for (const { id, provider } of removed) {
      await tx.insert(keyEvents).values({ id: newId(), ownerId, keyId: id, provider, kind: 'deleted' });
    }
    return removed.length;
  }

  async hideCampaigns(tx: DbTx, ownerId: string): Promise<number> {
    const rows = await tx
      .update(campaigns)
      .set({ state: 'deleting', updatedAt: sql`now()` })
      .where(and(eq(campaigns.ownerId, ownerId), eq(campaigns.state, 'active')))
      .returning({ id: campaigns.id });
    return rows.length;
  }

  async insertRun(tx: DbTx, run: { id: string; userId: string; holdHours: number }): Promise<void> {
    await tx.insert(deletionRuns).values({
      id: run.id,
      kind: 'account',
      subjectId: run.userId,
      ownerId: run.userId,
      step: 1,
      state: 'running',
      notBefore: sql`now() + make_interval(hours => ${run.holdHours})`,
    });
  }

  async findRunBySubject(tx: DbTx, userId: string): Promise<AccountRun | undefined> {
    const [row] = await tx
      .select()
      .from(deletionRuns)
      .where(and(eq(deletionRuns.kind, 'account'), eq(deletionRuns.subjectId, userId)));
    return row === undefined ? undefined : runOf(row);
  }

  async listRuns(tx: DbTx, query: AccountRunQuery): Promise<AccountRunListed[]> {
    const conditions = [eq(deletionRuns.kind, 'account')];
    if (query.state !== undefined) conditions.push(eq(deletionRuns.state, query.state));
    if (query.after !== undefined) {
      const { updatedAt, id } = query.after;
      const earlier = or(
        lt(deletionRuns.updatedAt, sql`${updatedAt}::timestamptz`),
        and(eq(deletionRuns.updatedAt, sql`${updatedAt}::timestamptz`), lt(deletionRuns.id, id)),
      );
      if (earlier !== undefined) conditions.push(earlier);
    }
    const rows = await tx
      .select()
      .from(deletionRuns)
      .where(and(...conditions))
      .orderBy(sql`${deletionRuns.updatedAt} desc`, sql`${deletionRuns.id} desc`)
      .limit(query.limit);
    return rows.map((row) => ({ ...runOf(row), updatedAtKey: row.updatedAt }));
  }

  async findRun(tx: DbTx, runId: string) {
    const [row] = await tx
      .select()
      .from(deletionRuns)
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.kind, 'account')));
    return row === undefined ? undefined : runOf(row);
  }

  async advance(tx: DbTx, runId: string, patch: { step: number; remainingObjects?: number | null }): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({
        step: patch.step,
        attempts: 0,
        lastErrorClass: null,
        ...(patch.remainingObjects === undefined ? {} : { remainingObjects: patch.remainingObjects }),
        updatedAt: sql`now()`,
      })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')));
  }

  async setNotBefore(tx: DbTx, runId: string, inMs: number): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({ notBefore: sql`now() + make_interval(secs => ${inMs / 1000})`, updatedAt: sql`now()` })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')));
  }

  async recordFailure(tx: DbTx, runId: string, errorClass: string): Promise<number> {
    const [row] = await tx
      .update(deletionRuns)
      .set({ attempts: sql`${deletionRuns.attempts} + 1`, lastErrorClass: errorClass, updatedAt: sql`now()` })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')))
      .returning({ attempts: deletionRuns.attempts });
    return row?.attempts ?? 0;
  }

  async markStuck(tx: DbTx, runId: string): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({ state: 'stuck', updatedAt: sql`now()` })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')));
  }

  async setRemaining(tx: DbTx, runId: string, remaining: number): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({ remainingObjects: remaining, updatedAt: sql`now()` })
      .where(eq(deletionRuns.id, runId));
  }

  async resume(tx: DbTx, runId: string): Promise<boolean> {
    const rows = await tx
      .update(deletionRuns)
      .set({ state: 'running', attempts: 0, notBefore: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.kind, 'account'), eq(deletionRuns.state, 'stuck')))
      .returning({ id: deletionRuns.id });
    return rows.length === 1;
  }

  async findSubject(tx: DbTx, userId: string): Promise<{ email: string; idpSubject: string } | undefined> {
    const [row] = await tx.select({ email: users.email, idpSubject: users.idpSubject }).from(users).where(eq(users.id, userId));
    return row;
  }

  async invitationsToRevoke(tx: DbTx, email: string): Promise<string[]> {
    const rows = await tx
      .select({ id: invitations.idpInvitationId })
      .from(invitations)
      .where(and(sql`lower(${invitations.email}) = lower(${email})`, eq(invitations.state, 'invited'), sql`${invitations.idpInvitationId} is not null`));
    return rows.flatMap((row) => (row.id === null ? [] : [row.id]));
  }

  async eraseSubjectRecords(tx: DbTx, subject: { email: string; idpSubject: string }): Promise<void> {
    await tx.delete(invitations).where(sql`lower(${invitations.email}) = lower(${subject.email})`);
    await tx
      .delete(accessRequests)
      .where(or(eq(accessRequests.idpSubject, subject.idpSubject), sql`lower(${accessRequests.email}) = lower(${subject.email})`));
  }

  async deleteUser(tx: DbTx, userId: string): Promise<void> {
    await tx.delete(users).where(eq(users.id, userId));
  }

  async complete(tx: DbTx, runId: string): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({ state: 'completed', remainingObjects: 0, lastErrorClass: null, updatedAt: sql`now()` })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')));
  }
}
