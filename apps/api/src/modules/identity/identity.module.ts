import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, SESSION_AUTHENTICATOR } from '../../platform/http/auth.guard.js';
import { LinkingService } from './application/linking.service.js';
import { MeService } from './application/me.service.js';
import {
  ACCESS_REQUEST_LOOKUP,
  AUTH_OPTIONS,
  INVITATION_STORE,
  SETTINGS_STORE,
  USER_STORE,
} from './application/ports.js';
import type { AuthOptions } from './application/ports.js';
import { SessionService } from './application/session.service.js';
import { AdminUsersService } from './application/admin-users.service.js';
import { ADMIN_USER_QUERIES, ADMIN_USER_STORE, CURSOR_KEY } from './application/admin.ports.js';
import { RevokeSessionsService } from './application/revoke-sessions.service.js';
import { AdminUserListQueries } from './infrastructure/admin-users.queries.js';
import { AccessRequestQueries } from './infrastructure/identity.queries.js';
import { AdminUsersController } from './transport/admin-users.controller.js';
import { MeController } from './transport/me.controller.js';
import { InvitationJobs, EXPIRE_INVITATIONS_QUEUE, INVITATION_JOB_OPTIONS } from './application/invitations.jobs.js';
import { INVITATION_OPTIONS, InvitationService, invitationOptionsFrom } from './application/invitations.service.js';
import { INVITATION_ADMIN_STORE, InvitationAdminStore } from './application/invitations.store.js';
import { InvitationsController } from './transport/invitations.controller.js';
import {
  ACCESS_REQUEST_OPTIONS,
  AccessRequestService,
  accessRequestOptionsFrom,
} from './application/access-requests.service.js';
import { ACCESS_REQUEST_STORE, AccessRequestAdminStore } from './application/access-requests.store.js';
import { SETTINGS_OPTIONS, SettingsService, settingsOptionsFrom } from './application/settings.service.js';
import { SETTINGS_ADMIN_STORE, SettingsAdminStore } from './application/settings.store.js';
import { AccessRequestsController, AdminAccessRequestsController } from './transport/access-requests.controller.js';
import { SettingsController } from './transport/settings.controller.js';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { RateLimiter } from '../../platform/rate-limit/index.js';
import { IDENTITY_PORT } from './domain/identity-port.js';
import type { IdentityPort } from './domain/identity-port.js';
import { ClerkIdentity } from './infrastructure/clerk-identity.js';
import { identityConfigFrom } from './infrastructure/identity.config.js';
import type { IdentityConfig } from './infrastructure/identity.config.js';
import {
  AccessRequestRepository,
  InvitationRepository,
  SettingsRepository,
  UserRepository,
} from './infrastructure/identity.repositories.js';
import { LocalIdentity } from './infrastructure/local-identity.js';

export { authOptionsFrom } from './application/ports.js';
export type { AuthOptions } from './application/ports.js';
export { identityConfigFrom };
export { InvitationJobs };
export type { IdentityConfig, IdentityMode } from './infrastructure/identity.config.js';
export {
  IDENTITY_PORT,
  IdentityNotFound,
  IdentityTokenInvalid,
  IdentityUnavailable,
} from './domain/identity-port.js';
export type { Claims, IdentityPort, IdentityUser } from './domain/identity-port.js';
export { LocalIdentity } from './infrastructure/local-identity.js';
export { AdminUsersService } from './application/admin-users.service.js';
export type { AdminChange, AdminUserView, RoleChange } from './application/admin-users.service.js';
export { REVOKE_SESSIONS_QUEUE } from './application/admin.ports.js';
export { RevokeSessionsService, revokeSessionsHandler } from './application/revoke-sessions.service.js';

/** The adapter the configuration selects: Clerk, or the local provider that needs no account. */
export function createIdentityPort(
  config: IdentityConfig,
  webOrigin?: string,
): IdentityPort {
  if (config.mode === 'local') {
    return new LocalIdentity(webOrigin === undefined ? {} : { authorizedParties: [webOrigin] });
  }
  if (config.secretKey === undefined || config.issuer === undefined) {
    throw new Error('clerk identity needs a secret key and an issuer');
  }
  return new ClerkIdentity({
    secretKey: config.secretKey,
    issuer: config.issuer,
    ...(config.authorizedParties === undefined
      ? {}
      : { authorizedParties: config.authorizedParties }),
  });
}

/** A worker job handler of this module (the worker composition root binds it to its queue). */
export type IdentityJobHandler = (job: unknown, log: { info(fields: object, message: string): void }) => Promise<void>;

/** The queue handlers of this module: `identity.expire-invitations` runs `InvitationJobs`, resolved when a job arrives. */
export function identityJobHandlers(
  resolve: () => InvitationJobs,
): Readonly<Record<string, IdentityJobHandler>> {
  return {
    [EXPIRE_INVITATIONS_QUEUE]: async (_job, log) => {
      const outcome = await resolve().run();
      log.info(
        { module: 'identity', outcome: 'ok' },
        `expire-invitations: ${String(outcome.expired)} expired, ${String(outcome.staleSends)} stale sends, ` +
          `${String(outcome.revoked)} provider revokes done, ${String(outcome.revokesOwed)} still owed`,
      );
    },
  };
}

/** The guard's configuration and the audit module instance of the composition root (the audit trail is layer 1). */
export interface IdentityAuth {
  readonly options: AuthOptions;
  readonly audit: DynamicModule;
}

@Module({})
export class IdentityModule {
  /**
   * `auth` switches on the session guard, API-001 and the linking service; it needs the database module, so the
   * composition root passes it only when a database is configured.
   */
  static register(config: IdentityConfig, auth?: IdentityAuth): DynamicModule {
    const repositories = [
      UserRepository,
      InvitationRepository,
      AccessRequestRepository,
      SettingsRepository,
    ];
    return {
      module: IdentityModule,
      providers: [
        { provide: IDENTITY_PORT, useValue: createIdentityPort(config, auth?.options.webOrigin) },
        ...repositories,
        ...(auth === undefined
          ? []
          : [
              { provide: AUTH_OPTIONS, useValue: auth.options },
              { provide: USER_STORE, useExisting: UserRepository },
              { provide: INVITATION_STORE, useExisting: InvitationRepository },
              { provide: SETTINGS_STORE, useExisting: SettingsRepository },
              { provide: ACCESS_REQUEST_LOOKUP, useClass: AccessRequestQueries },
              { provide: ADMIN_USER_STORE, useExisting: UserRepository },
              { provide: ADMIN_USER_QUERIES, useClass: AdminUserListQueries },
              { provide: CURSOR_KEY, useValue: process.env['CURSOR_SIGNING_KEY'] },
              LinkingService,
              MeService,
              { provide: RateLimiter, useFactory: (database: Database) => new RateLimiter(database.db), inject: [DATABASE] },
              {
                provide: INVITATION_OPTIONS,
                useValue: invitationOptionsFrom(process.env, auth.options.inviteEmailDomains, auth.options.webOrigin),
              },
              { provide: INVITATION_ADMIN_STORE, useClass: InvitationAdminStore },
              InvitationService,
              { provide: ACCESS_REQUEST_STORE, useClass: AccessRequestAdminStore },
              { provide: ACCESS_REQUEST_OPTIONS, useValue: accessRequestOptionsFrom(process.env) },
              AccessRequestService,
              { provide: SETTINGS_ADMIN_STORE, useClass: SettingsAdminStore },
              { provide: SETTINGS_OPTIONS, useValue: settingsOptionsFrom(process.env) },
              SettingsService,
              AdminUsersService,
              RevokeSessionsService,
              SessionService,
              { provide: SESSION_AUTHENTICATOR, useExisting: SessionService },
              { provide: APP_GUARD, useClass: AuthGuard },
            ]),
      ],
      imports: auth === undefined ? [] : [auth.audit],
      controllers: auth === undefined ? [] : [
              MeController,
              AdminUsersController,
              InvitationsController,
              AccessRequestsController,
              AdminAccessRequestsController,
              SettingsController,
            ],
      exports: [IDENTITY_PORT, ...(auth === undefined ? [] : [AdminUsersService, RevokeSessionsService])],
    };
  }

  /**
   * The worker side (REQ-003): the identity port and the hourly invitation job. `env` is the process environment
   * (`IDENTITY_MODE`, `CLERK_*`, `INVITATION_SEND_STALE_MIN`); the database module is the worker's.
   */
  static registerWorker(env: Readonly<Record<string, string | undefined>>): DynamicModule {
    const webOrigin = env['WEB_ORIGIN'];
    const stale = invitationOptionsFrom(env, [], webOrigin).sendStaleMin;
    return {
      module: IdentityModule,
      providers: [
        {
          provide: IDENTITY_PORT,
          useValue: createIdentityPort(identityConfigFrom(env, env['APP_ENV'] ?? 'development', webOrigin), webOrigin),
        },
        { provide: INVITATION_JOB_OPTIONS, useValue: { sendStaleMin: stale } },
        { provide: INVITATION_ADMIN_STORE, useClass: InvitationAdminStore },
        InvitationJobs,
      ],
      exports: [InvitationJobs],
    };
  }
}
