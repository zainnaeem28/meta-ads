// The identity boundary (ARCHITECTURE §1.3): the only way the api talks to the identity provider. Callers never see a
// provider SDK type, and no message of an error below carries a token, an email or a secret.

/** The verified claims of a session token. `fva` is minutes since the first and the second factor (-1: never). */
export interface Claims {
  readonly sub: string;
  readonly sid: string;
  readonly fva: readonly [number, number] | null;
  readonly iat: number;
  readonly exp: number;
  readonly azp: string | null;
}

export interface IdentityUser {
  readonly primaryEmail: string | null;
  readonly emailVerified: boolean;
}

export interface IdentityPort {
  /** Throws `IdentityTokenInvalid` for a bad, expired or foreign token, `IdentityUnavailable` when keys cannot be loaded. */
  verifyToken(jwt: string): Promise<Claims>;
  getUser(sub: string): Promise<IdentityUser>;
  /** Returns the provider's invitation id. */
  createInvitation(email: string, expiresInDays: number, redirectUrl: string): Promise<string>;
  revokeInvitation(idpInvitationId: string): Promise<void>;
  /** Ends every session of the subject. */
  revokeSessions(sub: string): Promise<void>;
  deleteUser(sub: string): Promise<void>;
}

/** Nest injection token of the active `IdentityPort`. */
export const IDENTITY_PORT = Symbol('IDENTITY_PORT');

/** The provider did not answer in time or answered with a failure: 503 on the request path, retried in erasure. */
export class IdentityUnavailable extends Error {
  constructor(
    readonly operation: string,
    readonly reason: 'timeout' | 'network' | 'provider' | 'keys',
  ) {
    super(`identity provider unavailable during ${operation} (${reason})`);
    this.name = 'IdentityUnavailable';
  }
}

/** The provider has no such user or invitation: treated as already done in erasure. */
export class IdentityNotFound extends Error {
  constructor(readonly operation: string) {
    super(`identity provider has no such object for ${operation}`);
    this.name = 'IdentityNotFound';
  }
}

/** The token is malformed, wrongly signed, expired, issued for another party or by another issuer: 401. */
export class IdentityTokenInvalid extends Error {
  constructor(readonly why: string) {
    super(`token refused: ${why}`);
    this.name = 'IdentityTokenInvalid';
  }
}
