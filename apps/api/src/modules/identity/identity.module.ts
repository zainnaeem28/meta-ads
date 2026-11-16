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
import { AccessRequestQueries } from './infrastructure/identity.queries.js';
import { MeController } from './transport/me.controller.js';
import { IDENTITY_PORT } from './domain/identity-port.js';
import type { IdentityPort } from './domain/identity-port.js';
import { ClerkIdentity } from './infrastructure/clerk-identity.js';
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
export { identityConfigFrom } from './infrastructure/identity.config.js';
export type { IdentityConfig, IdentityMode } from './infrastructure/identity.config.js';
export {
  IDENTITY_PORT,
  IdentityNotFound,
  IdentityTokenInvalid,
  IdentityUnavailable,
} from './domain/identity-port.js';
export type { Claims, IdentityPort, IdentityUser } from './domain/identity-port.js';
export { LocalIdentity } from './infrastructure/local-identity.js';

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
              LinkingService,
              MeService,
              SessionService,
              { provide: SESSION_AUTHENTICATOR, useExisting: SessionService },
              { provide: APP_GUARD, useClass: AuthGuard },
            ]),
      ],
      imports: auth === undefined ? [] : [auth.audit],
      controllers: auth === undefined ? [] : [MeController],
      exports: [IDENTITY_PORT],
    };
  }
}
