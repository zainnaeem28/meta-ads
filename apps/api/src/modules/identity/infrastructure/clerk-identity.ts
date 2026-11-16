import { createClerkClient } from '@clerk/backend';
import type { ClerkClient } from '@clerk/backend';
import { isClerkAPIResponseError } from '@clerk/backend/errors';
import { assertNoEgress } from '../../../platform/db/index.js';
import {
  IdentityNotFound,
  IdentityTokenInvalid,
  IdentityUnavailable,
} from '../domain/identity-port.js';
import type { Claims, IdentityPort, IdentityUser } from '../domain/identity-port.js';
import { JwksCache, verifySessionToken } from './jwt.js';
import type { JwkEntry } from './jwt.js';

export const PROVIDER_TIMEOUT_MS = 3_000;
export const JWKS_TTL_MS = 600_000;

export interface ClerkIdentityOptions {
  /** `sk_` secret; held by the SDK client only. */
  readonly secretKey: string;
  /** Required `iss` of session tokens (`CLERK_JWT_ISSUER`). */
  readonly issuer: string;
  readonly authorizedParties?: readonly string[];
  /** Test seam: the Backend API origin (the SDK default is Clerk's). */
  readonly apiUrl?: string;
  readonly timeoutMs?: number;
  readonly jwksTtlMs?: number;
  readonly now?: () => number;
}

/**
 * `IdentityPort` on `@clerk/backend` (ADR-002). Every call is bounded to 3 s, refuses to run inside a database
 * transaction, and fails with a typed error that carries the operation and a reason class only: SDK messages can
 * quote an email, so they are never copied. The adapter writes no log line.
 */
export class ClerkIdentity implements IdentityPort {
  private readonly client: ClerkClient;
  private readonly timeoutMs: number;
  private readonly cache: JwksCache;

  constructor(private readonly options: ClerkIdentityOptions) {
    this.timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    this.client = createClerkClient({
      secretKey: options.secretKey,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      telemetry: { disabled: true },
    });
    this.cache = new JwksCache(
      async () =>
        (await this.call('verifyToken', () => this.client.jwks.getJwks())).keys as JwkEntry[],
      options.jwksTtlMs ?? JWKS_TTL_MS,
      options.now ?? Date.now,
    );
  }

  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    assertNoEgress(`identity ${operation}`);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new IdentityUnavailable(operation, 'timeout')),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([run(), deadline]);
    } catch (error) {
      if (error instanceof IdentityUnavailable || error instanceof IdentityNotFound) throw error;
      if (isClerkAPIResponseError(error)) {
        if (error.status === 404) throw new IdentityNotFound(operation);
        throw new IdentityUnavailable(operation, 'provider');
      }
      throw new IdentityUnavailable(operation, 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  async verifyToken(jwt: string): Promise<Claims> {
    try {
      return await verifySessionToken(jwt, this.cache, {
        issuer: this.options.issuer,
        ...(this.options.authorizedParties === undefined
          ? {}
          : { authorizedParties: this.options.authorizedParties }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
    } catch (error) {
      if (error instanceof IdentityTokenInvalid || error instanceof IdentityUnavailable)
        throw error;
      throw new IdentityUnavailable('verifyToken', 'keys');
    }
  }

  async getUser(sub: string): Promise<IdentityUser> {
    const user = await this.call('getUser', () => this.client.users.getUser(sub));
    const primary = user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId);
    return {
      primaryEmail: primary?.emailAddress ?? null,
      emailVerified: primary?.verification?.status === 'verified',
    };
  }

  async createInvitation(
    email: string,
    expiresInDays: number,
    redirectUrl: string,
  ): Promise<string> {
    const invitation = await this.call('createInvitation', () =>
      this.client.invitations.createInvitation({ emailAddress: email, expiresInDays, redirectUrl }),
    );
    return invitation.id;
  }

  async revokeInvitation(idpInvitationId: string): Promise<void> {
    await this.call('revokeInvitation', () =>
      this.client.invitations.revokeInvitation(idpInvitationId),
    );
  }

  async revokeSessions(sub: string): Promise<void> {
    await this.call('revokeSessions', async () => {
      const sessions = await this.client.sessions.getSessionList({ userId: sub, status: 'active' });
      for (const session of sessions.data) await this.client.sessions.revokeSession(session.id);
    });
  }

  async deleteUser(sub: string): Promise<void> {
    await this.call('deleteUser', () => this.client.users.deleteUser(sub));
  }
}
