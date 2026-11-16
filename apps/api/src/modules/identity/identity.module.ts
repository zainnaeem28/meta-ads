import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
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
export function createIdentityPort(config: IdentityConfig): IdentityPort {
  if (config.mode === 'local') return new LocalIdentity();
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

@Module({})
export class IdentityModule {
  static register(config: IdentityConfig): DynamicModule {
    return {
      module: IdentityModule,
      providers: [
        { provide: IDENTITY_PORT, useValue: createIdentityPort(config) },
        UserRepository,
        InvitationRepository,
        AccessRequestRepository,
        SettingsRepository,
      ],
      exports: [IDENTITY_PORT],
    };
  }
}
