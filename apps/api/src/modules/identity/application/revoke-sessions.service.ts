import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { IDENTITY_PORT, IdentityNotFound } from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import { ADMIN_USER_STORE } from './admin.ports.js';
import type { AdminUserStore } from './admin.ports.js';

/**
 * `identity.revoke-sessions` (ARCHITECTURE 5.11, on demand, 5 retries by the queue): ends every provider session of
 * the account. Access is already blocked by the role and status read on every request, so this is a hygiene step; a
 * provider outage throws (the queue retries) and the exhausted job is logged as failed by the worker.
 */
@Injectable()
export class RevokeSessionsService {
  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(DATABASE) private readonly database: Pick<Database, 'db'>,
    @Inject(ADMIN_USER_STORE) private readonly users: AdminUserStore,
  ) {}

  async handle(data: unknown): Promise<void> {
    const userId = (data as { userId?: unknown } | null)?.userId;
    if (typeof userId !== 'string') throw new TypeError('identity.revoke-sessions needs a userId');
    const user = await this.users.findById(this.database.db, userId);
    if (user === undefined) return;
    try {
      await this.identity.revokeSessions(user.idpSubject);
    } catch (error) {
      // The provider has no such user: nothing to end.
      if (!(error instanceof IdentityNotFound)) throw error;
    }
  }
}

/** The queue handler the worker composition root registers for `identity.revoke-sessions`. */
export function revokeSessionsHandler(
  service: Pick<RevokeSessionsService, 'handle'>,
): (job: { readonly data: unknown }) => Promise<void> {
  return (job) => service.handle(job.data);
}
