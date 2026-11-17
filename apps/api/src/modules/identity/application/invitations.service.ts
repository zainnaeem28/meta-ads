import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { buildPage, decodeCursor, invalidCursor } from '../../../platform/http/cursor.js';
import { PageResult } from '../../../platform/http/response.js';
import { RateLimiter } from '../../../platform/rate-limit/index.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { AuditService } from '../../audit/index.js';
import { IDENTITY_PORT, IdentityNotFound } from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import { normalizeEmail } from '../domain/records.js';
import type { InvitationState, SendState } from '../domain/records.js';
import { settleProviderRevoke } from './invitations.jobs.js';
import { INVITATION_ADMIN_STORE } from './invitations.store.js';
import type { InvitationAdminStorePort, InvitationDb, InvitationRow } from './invitations.store.js';

export const INVITATION_OPTIONS = Symbol('INVITATION_OPTIONS');

export interface InvitationOptions {
  /** `INVITE_EMAIL_DOMAINS`: empty means any domain. */
  readonly allowedDomains: readonly string[];
  /** `INVITE_EXPIRY_DAYS` (7). */
  readonly expiryDays: number;
  /** `INVITATION_SEND_STALE_MIN`: a `pending` send older than this reads as `send_failed`. */
  readonly sendStaleMin: number;
  readonly webOrigin: string | undefined;
  /** `CURSOR_SIGNING_KEY`. */
  readonly cursorKey: string | undefined;
}

export function invitationOptionsFrom(
  env: Readonly<Record<string, string | undefined>>,
  allowedDomains: readonly string[],
  webOrigin: string | undefined,
): InvitationOptions {
  const whole = (raw: string | undefined, fallback: number): number => {
    const value = Number(raw);
    return raw !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    allowedDomains,
    expiryDays: whole(env['INVITE_EXPIRY_DAYS'], 7),
    sendStaleMin: whole(env['INVITATION_SEND_STALE_MIN'], 15),
    webOrigin,
    cursorKey: env['CURSOR_SIGNING_KEY'],
  };
}

/** API-111's shared rate limit: 20 per admin per hour, one bucket for invite and resend. */
export const INVITE_RATE = { limit: 20, windowSeconds: 3600 } as const;
export const INVITE_RATE_SCOPE = 'invitation-send';
export const INVITE_MESSAGE = 'If this address can be invited, an invitation is on its way.';
const DAY_MS = 86_400_000;
const NOT_FOUND = 'There is no such invitation.';
const NOT_INVITED = 'Only an invitation that is waiting can be changed.';

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly state: InvitationState;
  readonly sendState: SendState;
  readonly expiresAt: string;
  readonly invitedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InvitationActor {
  readonly userId: string;
  readonly requestId: string;
}

export interface InvitationListQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly state?: InvitationState | undefined;
}

const CURSOR_KEY =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?)\|([0-9a-f-]{36})$/;

/**
 * Invitations (ARCHITECTURE 5.1, TD-D29). The provider call never runs inside a transaction: the row is written first
 * (`invited`/`pending`), the provider is called, then `send_state` moves to `sent` or `send_failed`. The app never
 * holds or logs an invitation ticket (SECT-AUTH-14): the provider issues and verifies it, we keep only its handle,
 * which is never returned.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(INVITATION_ADMIN_STORE) private readonly store: InvitationAdminStorePort,
    @Inject(DATABASE) private readonly database: Pick<Database, 'db' | 'uow'>,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(AuditService) private readonly audit: Pick<AuditService, 'record'>,
    @Inject(RateLimiter) private readonly limiter: Pick<RateLimiter, 'enforce'>,
    @Inject(INVITATION_OPTIONS) private readonly options: InvitationOptions,
  ) {}

  /** API-110. Expired rows read as `expired` and stale `pending` sends as `send_failed`, whether or not the job ran. */
  async list(
    actor: InvitationActor,
    query: InvitationListQuery,
  ): Promise<PageResult<InvitationView>> {
    const key = this.options.cursorKey;
    if (key === undefined) throw new Error('CURSOR_SIGNING_KEY is not configured');
    const scope = { owner: actor.userId, filters: { state: query.state ?? null } };
    let after: { createdAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const match = CURSOR_KEY.exec(decodeCursor(key, query.cursor, scope));
      if (match === null) throw invalidCursor();
      after = { createdAt: match[1] as string, id: match[4] as string };
    }
    const rows = await this.store.list(this.database.db, {
      limit: query.limit,
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(after === undefined ? {} : { after }),
    });
    const page = buildPage(
      rows,
      query.limit,
      (row) => `${row.createdAtText}|${row.id}`,
      key,
      scope,
    );
    const now = Date.now();
    return new PageResult(
      page.items.map((row) => this.view(row, now)),
      page.pagination,
    );
  }

  /** API-111: the same answer for a fresh address, a registered one and a failed send. */
  async create(
    actor: InvitationActor,
    rawEmail: string,
  ): Promise<{ email: string; message: string }> {
    await this.limiter.enforce(INVITE_RATE_SCOPE, actor.userId, INVITE_RATE);
    const email = normalizeEmail(rawEmail);
    const domains = this.options.allowedDomains;
    if (domains.length > 0 && !domains.includes(email.slice(email.lastIndexOf('@') + 1))) {
      throw new DomainError(
        'invite_domain_not_allowed',
        'Invitations are limited to approved email domains.',
      );
    }
    const accepted = { email, message: INVITE_MESSAGE };
    if (await this.store.hasAccount(this.database.db, email)) return accepted;

    const id = newId();
    const replaced = await this.database.uow.run(async (tx) => {
      await this.store.lockEmail(tx, email);
      const previous = await this.store.revokeInvitedByEmail(tx, email);
      await this.store.insertInvited(tx, {
        id,
        email,
        invitedBy: actor.userId,
        expiresAt: this.expiry(),
      });
      await this.record(tx, actor, 'invitation.created', id);
      return previous;
    });
    // A replaced invitation is revoked at the provider only when its handle is set (a still-`pending` one has none).
    if (replaced?.idpInvitationId != null) {
      await settleProviderRevoke(
        this.identity,
        this.store,
        this.database.db,
        replaced.id,
        replaced.idpInvitationId,
      );
    }
    await this.deliver(id, email, false);
    return accepted;
  }

  /** API-112: any `invited` row in any send state; the old provider invitation is revoked first, if there is one. */
  async resend(actor: InvitationActor, id: string): Promise<InvitationView> {
    await this.limiter.enforce(INVITE_RATE_SCOPE, actor.userId, INVITE_RATE);
    const row = await this.database.uow.run(async (tx) => {
      const found = await this.store.findById(tx, id, true);
      if (found === undefined) throw new DomainError('not_found', NOT_FOUND);
      if (!this.waiting(found, Date.now())) throw new DomainError('state_conflict', NOT_INVITED);
      await this.store.restart(tx, id, this.expiry());
      await this.record(tx, actor, 'invitation.resent', id);
      return found;
    });
    let cleared = false;
    if (row.idpInvitationId !== null) {
      cleared = await this.revokeAtProvider(row.idpInvitationId);
      if (!cleared) {
        // The old invitation is still live at the provider: keep its handle, so the next resend revokes it first.
        await this.database.uow.run((tx) => this.store.markSendFailed(tx, id));
        return this.read(id);
      }
    }
    await this.deliver(id, row.email, cleared);
    return this.read(id);
  }

  /** API-113: revoking a revoked invitation returns it unchanged. */
  async revoke(actor: InvitationActor, id: string): Promise<InvitationView> {
    const handle = await this.database.uow.run(async (tx) => {
      const found = await this.store.findById(tx, id, true);
      if (found === undefined) throw new DomainError('not_found', NOT_FOUND);
      if (found.state === 'revoked') return null;
      if (!this.waiting(found, Date.now())) throw new DomainError('state_conflict', NOT_INVITED);
      await this.store.revoke(tx, id);
      await this.record(tx, actor, 'invitation.revoked', id);
      return found.idpInvitationId;
    });
    // A failed provider revoke is retried by the hourly job: the row keeps its handle until the revoke succeeds.
    if (handle !== null)
      await settleProviderRevoke(this.identity, this.store, this.database.db, id, handle);
    return this.read(id);
  }

  private async deliver(id: string, email: string, clearHandleOnFailure: boolean): Promise<void> {
    let handle: string | undefined;
    try {
      handle = await this.identity.createInvitation(
        email,
        this.options.expiryDays,
        `${this.options.webOrigin ?? ''}/sign-in`,
      );
    } catch {
      handle = undefined;
    }
    if (handle === undefined) {
      await this.database.uow.run((tx) => this.store.markSendFailed(tx, id, clearHandleOnFailure));
      return;
    }
    const issued = handle;
    const stored = await this.database.uow.run((tx) => this.store.markSent(tx, id, issued));
    // The row was revoked or marked stale while the provider call ran: the new provider invitation has no owner.
    if (!stored) await this.revokeAtProvider(issued);
  }

  /** `true` when the provider no longer has the invitation (revoked now, or never known). */
  private async revokeAtProvider(handle: string): Promise<boolean> {
    try {
      await this.identity.revokeInvitation(handle);
      return true;
    } catch (error) {
      return error instanceof IdentityNotFound;
    }
  }

  private async read(id: string): Promise<InvitationView> {
    const row = await this.store.findById(this.database.db, id);
    if (row === undefined) throw new DomainError('not_found', NOT_FOUND);
    return this.view(row, Date.now());
  }

  private waiting(row: InvitationRow, now: number): boolean {
    return row.state === 'invited' && row.expiresAt.getTime() > now;
  }

  private expiry(): Date {
    return new Date(Date.now() + this.options.expiryDays * DAY_MS);
  }

  private view(row: InvitationRow, now: number): InvitationView {
    const expired = row.state === 'invited' && row.expiresAt.getTime() <= now;
    const stale =
      row.state === 'invited' &&
      row.sendState === 'pending' &&
      row.updatedAt.getTime() < now - this.options.sendStaleMin * 60_000;
    return {
      id: row.id,
      email: row.email,
      state: expired ? 'expired' : row.state,
      sendState: stale ? 'send_failed' : row.sendState,
      expiresAt: row.expiresAt.toISOString(),
      invitedBy: row.invitedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async record(
    db: InvitationDb,
    actor: InvitationActor,
    action: 'invitation.created' | 'invitation.resent' | 'invitation.revoked',
    id: string,
  ): Promise<void> {
    await this.audit.record(db, {
      actorId: actor.userId,
      actorType: 'admin',
      action,
      objectType: 'invitation',
      objectId: id,
      outcome: 'allowed',
      requestId: actor.requestId,
    });
  }
}
