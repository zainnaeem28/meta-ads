import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '../../../platform/http/domain-error.js';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import type {
  ActorContext,
  ActorRole,
  AuthResult,
  SessionAuthenticator,
} from '../../../platform/http/auth.guard.js';
import { AuditService } from '../../audit/index.js';
import {
  IDENTITY_PORT,
  IdentityTokenInvalid,
  IdentityUnavailable,
} from '../domain/identity-port.js';
import type { Claims, IdentityPort } from '../domain/identity-port.js';
import { LinkingService } from './linking.service.js';
import { AUTH_OPTIONS, USER_STORE } from './ports.js';
import type { AuthOptions, UserRecord, UserStore } from './ports.js';

/** `fva` is minutes since the first and second factor; -1 (or no claim) means no such factor. */
export function mfaSatisfied(fva: Claims['fva']): boolean {
  return fva !== null && fva[1] >= 0;
}

/** Builds the actor from the row and the token: MFA from `fva` (TR-08), recent authentication from `fva` and the limit. */
export function actorOf(user: UserRecord, claims: Claims, options: AuthOptions): ActorContext {
  const role: ActorRole = user.role === 'admin' ? 'admin' : 'user';
  const required = options.mfaRequiredFor === 'all' || role === 'admin';
  const satisfied = mfaSatisfied(claims.fva);
  const max = options.recentAuthMaxAgeMin;
  const fva = claims.fva;
  const recent =
    fva !== null && fva[0] >= 0 && fva[0] <= max && (!required || (fva[1] >= 0 && fva[1] <= max));
  return {
    userId: user.id,
    role,
    sessionId: claims.sid,
    mfa: { required, satisfied },
    recentAuth: { satisfied: recent, maxAgeSeconds: max * 60 },
    authAgeMin: fva === null || fva[0] < 0 ? null : fva[0],
  };
}

@Injectable()
export class SessionService implements SessionAuthenticator {
  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(DATABASE) private readonly database: Pick<Database, 'db'>,
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
    @Inject(LinkingService) private readonly linking: Pick<LinkingService, 'linkOnFirstToken'>,
    @Optional() @Inject(AuditService) private readonly audit?: Pick<AuditService, 'record'>,
  ) {}

  async authenticate(token: string): Promise<AuthResult> {
    let claims: Claims;
    try {
      claims = await this.identity.verifyToken(token);
    } catch (error) {
      if (error instanceof IdentityTokenInvalid)
        throw new DomainError('unauthenticated', 'Sign in to continue.');
      if (error instanceof IdentityUnavailable) {
        throw new DomainError(
          'service_unavailable',
          'The service is temporarily unavailable. Try again shortly.',
        );
      }
      throw error;
    }
    // Status and role are read from the row on every request, never cached.
    const user =
      (await this.users.findBySubject(this.database.db, claims.sub)) ??
      (await this.linking.linkOnFirstToken(claims));
    if (user === undefined) return { linked: false, session: { subject: claims.sub } };
    if (user.status === 'suspended')
      throw new DomainError('account_suspended', 'This account is suspended.');
    if (user.status === 'removed')
      throw new DomainError('account_removed', 'This account has been removed.');
    return { linked: true, actor: actorOf(user, claims, this.options) };
  }

  async recordDenied(actor: ActorContext, requestId: string): Promise<void> {
    if (this.audit === undefined) return;
    try {
      await this.audit.record(this.database.db, {
        actorId: actor.userId,
        actorType: actor.role === 'admin' ? 'admin' : 'user',
        action: 'auth.denied',
        objectType: 'route',
        objectId: null,
        outcome: 'denied',
        requestId,
      });
    } catch {
      // The refusal itself is what the caller must see; a failed audit write is logged by the pool, not raised here.
    }
  }
}
