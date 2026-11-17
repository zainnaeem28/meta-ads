import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, isUniqueViolation } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { buildPage, decodeCursor, invalidCursor } from '../../../platform/http/cursor.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { PageResult } from '../../../platform/http/response.js';
import { RateLimiter, ipSubject } from '../../../platform/rate-limit/index.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { AuditService } from '../../audit/index.js';
import { IDENTITY_PORT, IdentityNotFound, IdentityUnavailable } from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import { normalizeEmail } from '../domain/records.js';
import type { AccessRequestState } from '../domain/records.js';
import { ACCESS_REQUEST_STORE } from './access-requests.store.js';
import type {
  AccessRequestDb,
  AccessRequestRow,
  AccessRequestStorePort,
} from './access-requests.store.js';
import { AUTH_OPTIONS } from './ports.js';
import type { AuthOptions } from './ports.js';

export const ACCESS_REQUEST_OPTIONS = Symbol('ACCESS_REQUEST_OPTIONS');

export interface AccessRequestOptions {
  /** `RATE_LIMIT_IP_KEY`: the HMAC key of the client IP. */
  readonly ipKey: string | undefined;
  /** `CURSOR_SIGNING_KEY`. */
  readonly cursorKey: string | undefined;
}

export function accessRequestOptionsFrom(
  env: Readonly<Record<string, string | undefined>>,
): AccessRequestOptions {
  return { ipKey: env['RATE_LIMIT_IP_KEY'], cursorKey: env['CURSOR_SIGNING_KEY'] };
}

/** API-002's limits: 3 per subject per hour, 20 per client IP per hour. */
export const ACCESS_REQUEST_SUBJECT_RATE = { limit: 3, windowSeconds: 3600 } as const;
export const ACCESS_REQUEST_IP_RATE = { limit: 20, windowSeconds: 3600 } as const;
export const ACCESS_REQUEST_SUBJECT_SCOPE = 'access-request-subject';
export const ACCESS_REQUEST_IP_SCOPE = 'access-request-ip';

const NOT_FOUND = 'There is no such access request.';

export interface AccessRequestView {
  readonly id: string;
  readonly email: string;
  readonly state: AccessRequestState;
  readonly note: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly userId: string | null;
}

export interface AccessRequestActor {
  readonly userId: string;
  readonly requestId: string;
}

export interface AccessRequestListQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly state: AccessRequestState;
}

const CURSOR_POSITION =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?)\|([0-9a-f-]{36})$/;

/** Access requests (ARCHITECTURE 3.3, 5.1; REQ-003). The requester's subject and email come from the token and the provider. */
@Injectable()
export class AccessRequestService {
  constructor(
    @Inject(ACCESS_REQUEST_STORE) private readonly store: AccessRequestStorePort,
    @Inject(DATABASE) private readonly database: Pick<Database, 'db' | 'uow'>,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(AuditService) private readonly audit: Pick<AuditService, 'record'>,
    @Inject(RateLimiter) private readonly limiter: Pick<RateLimiter, 'enforce'>,
    @Inject(AUTH_OPTIONS) private readonly auth: AuthOptions,
    @Inject(ACCESS_REQUEST_OPTIONS) private readonly options: AccessRequestOptions,
  ) {}

  /**
   * API-002. The answer is the same whether the request was recorded, one is pending, or the address already has an
   * account. Only an unlinked subject with a verified provider email gets a row; nobody else learns anything.
   */
  async create(
    subject: string,
    linked: boolean,
    ip: string,
    note: string | undefined,
  ): Promise<{ state: 'received' }> {
    if (!this.auth.accessRequestFormEnabled)
      throw new DomainError('not_found', 'There is nothing here.');
    await this.limiter.enforce(ACCESS_REQUEST_SUBJECT_SCOPE, subject, ACCESS_REQUEST_SUBJECT_RATE);
    if (this.options.ipKey === undefined) throw new Error('RATE_LIMIT_IP_KEY is not configured');
    await this.limiter.enforce(
      ACCESS_REQUEST_IP_SCOPE,
      ipSubject(this.options.ipKey, ip),
      ACCESS_REQUEST_IP_RATE,
    );
    const received = { state: 'received' } as const;
    if (linked) return received;

    // The provider call stays outside the transaction (ARCHITECTURE 1.5).
    let email: string;
    try {
      const profile = await this.identity.getUser(subject);
      if (profile.primaryEmail === null || !profile.emailVerified) return received;
      email = normalizeEmail(profile.primaryEmail);
    } catch (error) {
      if (error instanceof IdentityNotFound) return received;
      if (error instanceof IdentityUnavailable) {
        throw new DomainError(
          'service_unavailable',
          'The service is temporarily unavailable. Try again shortly.',
        );
      }
      throw error;
    }
    await this.database.uow.run(async (tx) => {
      if (await this.store.hasAccountForEmail(tx, email)) return;
      const id = newId();
      const trimmed = note?.trim();
      const inserted = await this.store.insertPending(tx, {
        id,
        idpSubject: subject,
        email,
        note: trimmed === undefined || trimmed === '' ? null : trimmed,
      });
      if (!inserted) return;
      await this.audit.record(tx, {
        actorId: null,
        actorType: 'system',
        action: 'access_request.created',
        objectType: 'access_request',
        objectId: id,
        outcome: 'allowed',
      });
    });
    return received;
  }

  /** API-115. */
  async list(
    actor: AccessRequestActor,
    query: AccessRequestListQuery,
  ): Promise<PageResult<AccessRequestView>> {
    const key = this.options.cursorKey;
    if (key === undefined) throw new Error('CURSOR_SIGNING_KEY is not configured');
    const scope = { owner: actor.userId, filters: { state: query.state } };
    let after: { createdAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const match = CURSOR_POSITION.exec(decodeCursor(key, query.cursor, scope));
      if (match === null) throw invalidCursor();
      after = { createdAt: match[1] as string, id: match[4] as string };
    }
    const rows = await this.store.list(this.database.db, {
      state: query.state,
      limit: query.limit,
      ...(after === undefined ? {} : { after }),
    });
    const page = buildPage(
      rows,
      query.limit,
      (row) => `${row.createdAtText}|${row.id}`,
      key,
      scope,
    );
    return new PageResult(
      page.items.map((row) => this.view(row)),
      page.pagination,
    );
  }

  /**
   * API-116: creates the `users` row (role `user`, linked via `access_request`). Approving an approved request returns
   * it unchanged; a declined one is a state conflict.
   */
  async approve(actor: AccessRequestActor, id: string): Promise<AccessRequestView> {
    try {
      return await this.database.uow.run(async (tx) => {
        const found = await this.store.findById(tx, id, true);
        if (found === undefined) throw new DomainError('not_found', NOT_FOUND);
        if (found.state === 'approved') return this.view(found);
        if (found.state !== 'pending')
          throw new DomainError('state_conflict', 'Only a pending request can be approved.');
        const domains = this.auth.inviteEmailDomains;
        if (
          domains.length > 0 &&
          !domains.includes(found.email.slice(found.email.lastIndexOf('@') + 1))
        ) {
          throw new DomainError(
            'invite_domain_not_allowed',
            'Access is limited to approved email domains.',
          );
        }
        const existing = await this.store.findAccount(tx, found.idpSubject, found.email);
        if (existing !== undefined && existing.idpSubject !== found.idpSubject) {
          throw new DomainError('state_conflict', 'That email address already has an account.');
        }
        const userId = existing?.id ?? newId();
        if (existing === undefined) {
          await this.store.insertUser(tx, {
            id: userId,
            idpSubject: found.idpSubject,
            email: found.email,
          });
        }
        if (!(await this.store.decide(tx, id, 'approved', actor.userId, userId))) {
          throw new DomainError('state_conflict', 'Only a pending request can be approved.');
        }
        await this.record(tx, actor, 'access_request.approved', id);
        return this.view(await this.mustRead(tx, id));
      });
    } catch (error) {
      // A concurrent first token or approve created the account between the check and the insert.
      if (isUniqueViolation(error))
        throw new DomainError('state_conflict', 'That email address already has an account.');
      throw error;
    }
  }

  /** API-117: declining a declined request returns it unchanged. */
  async decline(actor: AccessRequestActor, id: string): Promise<AccessRequestView> {
    return this.database.uow.run(async (tx) => {
      const found = await this.store.findById(tx, id, true);
      if (found === undefined) throw new DomainError('not_found', NOT_FOUND);
      if (found.state === 'declined') return this.view(found);
      if (found.state !== 'pending')
        throw new DomainError('state_conflict', 'Only a pending request can be declined.');
      if (!(await this.store.decide(tx, id, 'declined', actor.userId, null))) {
        throw new DomainError('state_conflict', 'Only a pending request can be declined.');
      }
      await this.record(tx, actor, 'access_request.declined', id);
      return this.view(await this.mustRead(tx, id));
    });
  }

  private async mustRead(db: AccessRequestDb, id: string): Promise<AccessRequestRow> {
    const row = await this.store.findById(db, id);
    if (row === undefined) throw new DomainError('not_found', NOT_FOUND);
    return row;
  }

  private view(row: AccessRequestRow): AccessRequestView {
    return {
      id: row.id,
      email: row.email,
      state: row.state,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
      decidedBy: row.decidedBy,
      userId: row.userId,
    };
  }

  private async record(
    db: AccessRequestDb,
    actor: AccessRequestActor,
    action: 'access_request.approved' | 'access_request.declined',
    id: string,
  ): Promise<void> {
    await this.audit.record(db, {
      actorId: actor.userId,
      actorType: 'admin',
      action,
      objectType: 'access_request',
      objectId: id,
      outcome: 'allowed',
      requestId: actor.requestId,
    });
  }
}
