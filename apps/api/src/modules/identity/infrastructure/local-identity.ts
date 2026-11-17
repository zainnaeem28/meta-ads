import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { IdentityNotFound, IdentityUnavailable } from '../domain/identity-port.js';
import type { Claims, IdentityPort, IdentityUser } from '../domain/identity-port.js';
import { JwksCache, verifySessionToken } from './jwt.js';
import type { JwkEntry } from './jwt.js';

export const LOCAL_ISSUER = 'https://identity.local.invalid';
const TEN_MINUTES_MS = 600_000;

export interface LocalUser {
  readonly sub: string;
  email: string | null;
  emailVerified: boolean;
}

export interface LocalInvitation {
  readonly id: string;
  readonly email: string;
  readonly expiresInDays: number;
  revoked: boolean;
}

export interface TokenSpec {
  readonly sub: string;
  readonly sid?: string;
  /** Minutes since the first and second factor; absent means no factor evidence. */
  readonly fva?: readonly [number, number];
  readonly azp?: string;
  readonly iat?: number;
  readonly ttlSeconds?: number;
  readonly issuer?: string;
  readonly kid?: string;
}

/**
 * The local identity provider: an in-process user directory, an RSA key pair and a JWKS, used by the tests and, with
 * `IDENTITY_MODE=local`, by the local stack (no account at any vendor). It verifies tokens through the same
 * `verifySessionToken` the Clerk adapter uses, so a token it mints exercises the production verification path.
 */
export class LocalIdentity implements IdentityPort {
  readonly users = new Map<string, LocalUser>();
  readonly invitations = new Map<string, LocalInvitation>();
  readonly sessionRevocations: string[] = [];
  /** While false every call fails as a provider outage would. */
  available = true;
  private readonly privateKey: KeyObject;
  private readonly publicJwk: JwkEntry;
  private readonly cache: JwksCache;

  constructor(
    private readonly options: {
      issuer?: string;
      authorizedParties?: readonly string[];
      now?: () => number;
      kid?: string;
    } = {},
  ) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    const kid = options.kid ?? `local-${randomUUID()}`;
    this.publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
    this.cache = new JwksCache(
      async () => this.jwks().keys,
      TEN_MINUTES_MS,
      this.options.now ?? Date.now,
    );
  }

  get issuer(): string {
    return this.options.issuer ?? LOCAL_ISSUER;
  }

  /** The `azp` of a token a browser session would carry: the configured web origin, when there is one. */
  get authorizedParty(): string | undefined {
    return this.options.authorizedParties?.[0];
  }

  jwks(): { keys: JwkEntry[] } {
    return { keys: [this.publicJwk] };
  }

  addUser(sub: string, email: string | null, emailVerified = true): LocalUser {
    const user = { sub, email, emailVerified };
    this.users.set(sub, user);
    return user;
  }

  /** Mints a session token signed with this provider's key (the `kid` and `issuer` can be overridden to build bad tokens). */
  issueToken(spec: TokenSpec): string {
    const now = Math.floor((this.options.now ?? Date.now)() / 1000);
    const iat = spec.iat ?? now;
    const payload: Record<string, unknown> = {
      iss: spec.issuer ?? this.issuer,
      sub: spec.sub,
      sid: spec.sid ?? `sess_${spec.sub}`,
      iat,
      exp: iat + (spec.ttlSeconds ?? 60),
      ...(spec.fva === undefined ? {} : { fva: spec.fva }),
      ...(spec.azp === undefined ? {} : { azp: spec.azp }),
    };
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const head = `${part({ alg: 'RS256', typ: 'JWT', kid: spec.kid ?? this.publicJwk.kid })}.${part(payload)}`;
    const signature = createSign('RSA-SHA256')
      .update(head)
      .sign(this.privateKey)
      .toString('base64url');
    return `${head}.${signature}`;
  }

  private up(operation: string): void {
    if (!this.available) throw new IdentityUnavailable(operation, 'provider');
  }

  async verifyToken(jwt: string): Promise<Claims> {
    this.up('verifyToken');
    return verifySessionToken(jwt, this.cache, {
      issuer: this.issuer,
      ...(this.options.authorizedParties === undefined
        ? {}
        : { authorizedParties: this.options.authorizedParties }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
  }

  async getUser(sub: string): Promise<IdentityUser> {
    this.up('getUser');
    const user = this.users.get(sub);
    if (user === undefined) throw new IdentityNotFound('getUser');
    return { primaryEmail: user.email, emailVerified: user.emailVerified };
  }

  async createInvitation(email: string, expiresInDays: number): Promise<string> {
    this.up('createInvitation');
    const id = `inv_${randomUUID().replaceAll('-', '')}`;
    this.invitations.set(id, { id, email, expiresInDays, revoked: false });
    return id;
  }

  async revokeInvitation(idpInvitationId: string): Promise<void> {
    this.up('revokeInvitation');
    const invitation = this.invitations.get(idpInvitationId);
    if (invitation === undefined) throw new IdentityNotFound('revokeInvitation');
    invitation.revoked = true;
  }

  async revokeSessions(sub: string): Promise<void> {
    this.up('revokeSessions');
    // An unknown subject has no sessions: nothing to end (the provider answers an empty list, not an error).
    this.sessionRevocations.push(sub);
  }

  async deleteUser(sub: string): Promise<void> {
    this.up('deleteUser');
    if (!this.users.delete(sub)) throw new IdentityNotFound('deleteUser');
  }
}
