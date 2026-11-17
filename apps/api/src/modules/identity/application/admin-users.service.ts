import { Inject, Injectable } from '@nestjs/common';
import { BOSS } from '../../../platform/jobs/boss.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { DATABASE, lockXact } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { buildPage, decodeCursor } from '../../../platform/http/cursor.js';
import { PageResult } from '../../../platform/http/response.js';
import type { ActorContext } from '../../../platform/http/auth.guard.js';
import { ALERT_PORT, AuditService } from '../../audit/index.js';
import type { AlertPort } from '../../audit/index.js';
import type { Role, UserStatus } from '../domain/records.js';
import {
  ADMIN_USER_QUERIES,
  ADMIN_USER_STORE,
  CURSOR_KEY,
  REVOKE_SESSIONS_QUEUE,
} from './admin.ports.js';
import type { AdminUserQueries, AdminUserRecord, AdminUserStore } from './admin.ports.js';

/** The change an administrator-affecting action makes to an account (ARCHITECTURE 3.3, API-104 and lifecycle). */
export type AdminChange = 'demote' | 'suspend' | 'remove';

export interface AdminUserView {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly status: UserStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Filled by the lifecycle module's deletion run (not built yet): there is no run to show. */
  readonly erasure: null;
}

export interface ListUsersInput {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly status?: UserStatus | undefined;
}

export interface RoleChange {
  readonly user: AdminUserView;
  readonly changed: boolean;
}

const REFUSALS = new Set(['self_action', 'last_admin']);
const asRole = (value: string): Role => (value === 'admin' ? 'admin' : 'user');
const asStatus = (value: string): UserStatus =>
  value === 'suspended' || value === 'removed' ? value : 'active';

export function viewOf(user: AdminUserRecord): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    role: asRole(user.role),
    status: asStatus(user.status),
    version: user.version,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    erasure: null,
  };
}

/**
 * The admin side of identity (REQ-026, ARCHITECTURE 3.3 and 5.1): the account list, the role change, and the
 * invariant that keeps at least one active admin. Every decision reads the rows under the `admin-invariant` lock, so
 * two concurrent demotions are serialised and the second sees the first.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'db' | 'uow'>,
    @Inject(ADMIN_USER_STORE) private readonly users: AdminUserStore,
    @Inject(ADMIN_USER_QUERIES) private readonly queries: AdminUserQueries,
    @Inject(AuditService) private readonly audit: Pick<AuditService, 'record'>,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(CURSOR_KEY) private readonly cursorKey: string | undefined,
  ) {}

  /** API-100: accounts newest first, with email (the only screen that shows it). */
  async listUsers(actor: ActorContext, input: ListUsersInput): Promise<PageResult<AdminUserView>> {
    const key = this.requireKey();
    const scope = { owner: actor.userId, filters: { status: input.status ?? null } };
    let after;
    if (input.cursor !== undefined) {
      const sortKey = decodeCursor(key, input.cursor, scope);
      const at = sortKey.indexOf('|');
      const id = sortKey.slice(at + 1);
      if (at < 1 || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(Date.parse(sortKey.slice(0, at)))) {
        throw new DomainError('validation_failed', 'The request is not valid.', [
          {
            field: 'cursor',
            code: 'cursor_invalid',
            message: 'The cursor is invalid or has expired.',
          },
        ]);
      }
      after = { createdAt: sortKey.slice(0, at), id };
    }
    const rows = await this.queries.list(this.database.db, {
      limit: input.limit + 1,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(after === undefined ? {} : { after }),
    });
    const page = buildPage(rows, input.limit, (row) => `${row.createdAtKey}|${row.id}`, key, scope);
    return new PageResult(
      page.items.map((row) => viewOf(row)),
      page.pagination,
    );
  }

  /**
   * API-104. Same role: 200 unchanged, no event. Otherwise one transaction: the invariant under its lock, the
   * versioned update, the audit event, the alert, and the session-revoke job (it exists only if this commits).
   */
  async setRole(
    actor: ActorContext,
    userId: string,
    role: Role,
    expectedVersion: number,
    requestId: string,
  ): Promise<RoleChange> {
    const pending: { announce(): void }[] = [];
    const outcome = await this.database.uow.run(async (tx) => {
      await lockXact(tx, 'admin-invariant');
      const target = await this.users.findById(tx, userId);
      if (target === undefined) throw new DomainError('not_found', 'The account was not found.');
      if (target.role === role) return { user: target, changed: false as const };
      if (target.status !== 'active') {
        throw new DomainError('state_conflict', 'The account is not active.');
      }
      if (target.version !== expectedVersion) {
        throw new DomainError('version_conflict', 'The account changed. Reload and try again.');
      }
      try {
        if (role === 'user') await this.assertAdminInvariant(tx, actor.userId, target, 'demote');
        else await this.assertNotSelf(actor.userId, target);
      } catch (error) {
        if (error instanceof DomainError && REFUSALS.has(error.code)) {
          await this.recordRefusal(tx, actor, target.id, requestId);
          return { refused: error };
        }
        throw error;
      }
      const updated = await this.users.setRole(tx, userId, expectedVersion, role);
      if (updated === undefined) {
        throw new DomainError('version_conflict', 'The account changed. Reload and try again.');
      }
      await this.audit.record(tx, {
        actorId: actor.userId,
        actorType: 'admin',
        action: role === 'admin' ? 'role.granted' : 'role.revoked',
        objectType: 'user',
        objectId: userId,
        outcome: 'allowed',
        requestId,
      });
      const admins = await this.users.countActiveAdmins(tx);
      pending.push(await this.alerts.raiseAlert(tx, 'admin_role_changed', userId, { admins }));
      await enqueue(this.boss, tx, REVOKE_SESSIONS_QUEUE, { userId });
      return { user: updated, changed: true as const };
    });
    if ('refused' in outcome) throw outcome.refused;
    for (const alert of pending) alert.announce();
    return { user: viewOf(outcome.user), changed: outcome.changed };
  }

  /**
   * Status change for the lifecycle module (suspend, reinstate, remove), inside its transaction `tx`. The invariant
   * is checked under the same lock; the lifecycle caller records its own success events. A refusal is audited on its
   * own connection (the caller's transaction ends with the error) and raised.
   */
  async setStatus(
    tx: DbTx,
    input: { actorId: string | null; userId: string; status: UserStatus; expectedVersion: number },
  ): Promise<AdminUserView> {
    await lockXact(tx, 'admin-invariant');
    const target = await this.users.findById(tx, input.userId);
    if (target === undefined) throw new DomainError('not_found', 'The account was not found.');
    if (target.status === input.status) return viewOf(target);
    if (target.status === 'removed')
      throw new DomainError('state_conflict', 'The account was removed.');
    if (target.version !== input.expectedVersion) {
      throw new DomainError('version_conflict', 'The account changed. Reload and try again.');
    }
    if (input.status !== 'active') {
      try {
        await this.assertAdminInvariant(
          tx,
          input.actorId,
          target,
          input.status === 'removed' ? 'remove' : 'suspend',
        );
      } catch (error) {
        if (error instanceof DomainError && REFUSALS.has(error.code)) {
          await this.audit.record(this.database.db, {
            actorId: input.actorId,
            actorType: input.actorId === null ? 'system' : 'admin',
            action: 'admin_invariant.refused',
            objectType: 'user',
            objectId: target.id,
            outcome: 'denied',
          });
        }
        throw error;
      }
    }
    const updated = await this.users.setStatus(
      tx,
      input.userId,
      input.expectedVersion,
      input.status,
    );
    if (updated === undefined) {
      throw new DomainError('version_conflict', 'The account changed. Reload and try again.');
    }
    if (input.status !== 'active')
      await enqueue(this.boss, tx, REVOKE_SESSIONS_QUEUE, { userId: input.userId });
    return viewOf(updated);
  }

  /**
   * The admin invariant (SB 3.4): an administrator cannot act on themselves, and the last active admin cannot be
   * demoted, suspended or removed. Call it with the `admin-invariant` lock held.
   */
  async assertAdminInvariant(
    tx: DbTx,
    actorId: string | null,
    target: Pick<AdminUserRecord, 'id' | 'role' | 'status'>,
    change: AdminChange,
  ): Promise<void> {
    await this.assertNotSelf(actorId, target);
    if (
      target.role === 'admin' &&
      target.status === 'active' &&
      (await this.users.countActiveAdmins(tx)) <= 1
    ) {
      throw new DomainError('last_admin', `The last administrator cannot be ${verb(change)}.`);
    }
  }

  private assertNotSelf(
    actorId: string | null,
    target: Pick<AdminUserRecord, 'id'>,
  ): Promise<void> {
    if (actorId !== null && actorId === target.id) {
      return Promise.reject(
        new DomainError('self_action', 'You cannot do this to your own account.'),
      );
    }
    return Promise.resolve();
  }

  private async recordRefusal(
    tx: DbTx,
    actor: ActorContext,
    targetId: string,
    requestId: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      actorId: actor.userId,
      actorType: 'admin',
      action: 'admin_invariant.refused',
      objectType: 'user',
      objectId: targetId,
      outcome: 'denied',
      requestId,
    });
  }

  private requireKey(): string {
    if (this.cursorKey === undefined || this.cursorKey === '')
      throw new Error('CURSOR_SIGNING_KEY is not configured');
    return this.cursorKey;
  }
}

const verb = (change: AdminChange): string =>
  change === 'demote' ? 'demoted' : change === 'suspend' ? 'suspended' : 'removed';
