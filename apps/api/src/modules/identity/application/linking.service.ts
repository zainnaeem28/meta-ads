import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, isUniqueViolation, lockXact } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { AuditService } from '../../audit/index.js';
import { IdentityNotFound, IdentityUnavailable, IDENTITY_PORT } from '../domain/identity-port.js';
import type { Claims, IdentityPort } from '../domain/identity-port.js';
import { normalizeEmail } from '../domain/records.js';
import { AUTH_OPTIONS, INVITATION_STORE, SETTINGS_STORE, USER_STORE } from './ports.js';
import type {
  AuthOptions,
  InvitationStore,
  SettingsStore,
  UserRecord,
  UserStore,
} from './ports.js';

class NoBasis extends Error {}

/**
 * Linking on the first verified token (ARCHITECTURE 5.1, FLOW-12), one transaction: first admin, invitation, open
 * signup. An approved access request has no first-token path (API-116 inserts the row). Idempotent: a subject that
 * has a row gets that row, so two concurrent first tokens end with one `users` row.
 */
@Injectable()
export class LinkingService {
  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(DATABASE) private readonly database: Pick<Database, 'db' | 'uow'>,
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(INVITATION_STORE) private readonly invitations: InvitationStore,
    @Inject(SETTINGS_STORE) private readonly settings: SettingsStore,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
    @Inject(AuditService) private readonly audit: Pick<AuditService, 'record'>,
  ) {}

  /** The account of the token's subject, created when a basis exists; `undefined` when none applies (not linked). */
  async linkOnFirstToken(claims: Claims): Promise<UserRecord | undefined> {
    // The provider call stays outside the transaction (ARCHITECTURE 1.5).
    let profile;
    try {
      profile = await this.identity.getUser(claims.sub);
    } catch (error) {
      if (error instanceof IdentityNotFound) return undefined;
      if (error instanceof IdentityUnavailable) {
        throw new DomainError(
          'service_unavailable',
          'The service is temporarily unavailable. Try again shortly.',
        );
      }
      throw error;
    }
    if (profile.primaryEmail === null || !profile.emailVerified) return undefined;
    const email = normalizeEmail(profile.primaryEmail);
    try {
      return await this.database.uow.run((tx) => this.decide(tx, claims, email));
    } catch (error) {
      if (error instanceof NoBasis) return undefined;
      // Another subject already holds this email (users_email_lower_uq): no second account, no enumeration.
      if (isUniqueViolation(error, 'users_email_lower_uq')) {
        return this.users.findBySubject(this.database.db, claims.sub);
      }
      throw error;
    }
  }

  private async decide(tx: DbTx, claims: Claims, email: string): Promise<UserRecord> {
    const mfa = claims.fva !== null && claims.fva[1] >= 0;
    if (this.options.ownerEmail === email && mfa) {
      // Serializes the first-admin decision with every other admin change; the marker closes the path for good.
      await lockXact(tx, 'admin-invariant');
      const existing = await this.users.findBySubject(tx, claims.sub);
      if (existing !== undefined) return existing;
      const settings = await this.settings.get(tx);
      if (settings.firstAdminSeededAt === null && (await this.users.countActiveAdmins(tx)) === 0) {
        const row = await this.users.insertIfAbsent(tx, {
          id: newId(),
          idpSubject: claims.sub,
          email,
          role: 'admin',
          linkedVia: 'first_admin',
        });
        if (row !== undefined) {
          await this.settings.markFirstAdminSeeded(tx);
          await this.record(tx, row, 'auth.first_admin_seeded');
          return row;
        }
      }
    }
    const invitation = await this.invitations.findInvitedByEmail(tx, email);
    if (invitation !== undefined && invitation.expiresAt.getTime() > Date.now()) {
      const row = await this.users.insertIfAbsent(tx, {
        id: newId(),
        idpSubject: claims.sub,
        email,
        linkedVia: 'invitation',
      });
      if (row === undefined) return this.existing(tx, claims);
      if (!(await this.invitations.transition(tx, invitation.id, 'accepted', row.id)))
        throw new NoBasis();
      await this.record(tx, row, 'auth.linked');
      return row;
    }
    const settings = await this.settings.get(tx);
    if (settings.signupMode === 'open' && this.domainAllowed(email)) {
      const row = await this.users.insertIfAbsent(tx, {
        id: newId(),
        idpSubject: claims.sub,
        email,
        linkedVia: 'open_signup',
      });
      if (row === undefined) return this.existing(tx, claims);
      await this.record(tx, row, 'auth.linked');
      return row;
    }
    // A concurrent first token of the same subject may have linked it while this one found no basis.
    return this.existing(tx, claims);
  }

  private async existing(tx: DbTx, claims: Claims): Promise<UserRecord> {
    const row = await this.users.findBySubject(tx, claims.sub);
    if (row === undefined) throw new NoBasis();
    return row;
  }

  private domainAllowed(email: string): boolean {
    const domains = this.options.inviteEmailDomains;
    return domains.length === 0 || domains.includes(email.slice(email.lastIndexOf('@') + 1));
  }

  private async record(
    tx: DbTx,
    row: UserRecord,
    action: 'auth.first_admin_seeded' | 'auth.linked',
  ): Promise<void> {
    await this.audit.record(tx, {
      actorId: row.id,
      actorType: row.role === 'admin' ? 'admin' : 'user',
      action,
      objectType: 'user',
      objectId: row.id,
      outcome: 'allowed',
    });
  }
}
