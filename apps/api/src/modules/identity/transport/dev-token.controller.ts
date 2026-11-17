import { createHash } from 'node:crypto';
import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { Scope } from '../../../platform/http/scope-registry.js';
import { parseWith } from '../../../platform/http/validation.pipe.js';
import { IDENTITY_PORT } from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import { LocalIdentity } from '../infrastructure/local-identity.js';

const TOKEN_TTL_SECONDS = 3600;
const body = z.strictObject({
  email: z.email().max(254),
  /** Whether the token carries second-factor evidence (`fva[1] = 0`); `true` unless the caller says otherwise. */
  secondFactor: z.boolean().default(true),
});

export interface DevToken {
  readonly token: string;
  readonly sub: string;
  readonly email: string;
  readonly expiresInSeconds: number;
}

/**
 * Local/test token route. Mounted by `IdentityModule.register` only for `IDENTITY_MODE=local` with `APP_ENV`
 * development or test (see `devTokenRouteAllowed`); in staging or production the controller is not part of the module.
 * It mints a token with the in-process local provider, so the guard still verifies signature, issuer, expiry and `azp`
 * and still reads role, status and tenancy from the database; it grants nothing a signed-in local user lacks.
 */
@Controller('dev')
export class DevTokenController {
  constructor(@Inject(IDENTITY_PORT) identity: IdentityPort) {
    // Startup check: a non-local identity adapter cannot sign these tokens, so the route refuses to exist.
    if (!(identity instanceof LocalIdentity)) throw new Error('the local token route needs the local identity provider');
    this.local = identity;
  }

  private readonly local: LocalIdentity;

  @Post('token')
  @Scope('Pub')
  @HttpCode(200)
  token(@Body() input: unknown): DevToken {
    const parsed = parseWith(body, input);
    const email = parsed.email.toLowerCase();
    const sub = `user_local_${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
    this.local.addUser(sub, email, true);
    // `azp` is the web origin the guard requires, when one is configured; absent otherwise (as the provider omits it).
    const token = this.local.issueToken({
      sub,
      fva: [0, parsed.secondFactor ? 0 : -1],
      ttlSeconds: TOKEN_TTL_SECONDS,
      ...(this.local.authorizedParty === undefined ? {} : { azp: this.local.authorizedParty }),
    });
    return { token, sub, email, expiresInSeconds: TOKEN_TTL_SECONDS };
  }
}
