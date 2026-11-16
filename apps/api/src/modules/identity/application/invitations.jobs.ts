import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { IDENTITY_PORT, IdentityNotFound } from '../domain/identity-port.js';
import type { IdentityPort } from '../domain/identity-port.js';
import { INVITATION_ADMIN_STORE } from './invitations.store.js';
import type { InvitationAdminStorePort, InvitationDb } from './invitations.store.js';

/** The hourly queue (ARCHITECTURE 5.11). */
export const EXPIRE_INVITATIONS_QUEUE = 'identity.expire-invitations';
export const INVITATION_JOB_OPTIONS = Symbol('INVITATION_JOB_OPTIONS');

export interface InvitationJobOptions {
  /** `INVITATION_SEND_STALE_MIN`: a `pending` send untouched for this long is `send_failed`. */
  readonly sendStaleMin: number;
}

const BATCH = 200;

export interface ExpireOutcome {
  readonly expired: number;
  readonly staleSends: number;
  readonly revoked: number;
  /** Provider revokes that failed and stay owed for the next run. */
  readonly revokesOwed: number;
}

/**
 * Revokes the provider invitation of a closed row and clears the handle (nothing owed any more). A provider that does
 * not know the invitation counts as done; any other failure leaves the handle for the next run. Never throws, never
 * logs the handle.
 */
export async function settleProviderRevoke(
  identity: Pick<IdentityPort, 'revokeInvitation'>,
  store: Pick<InvitationAdminStorePort, 'clearHandle'>,
  db: InvitationDb,
  id: string,
  handle: string,
): Promise<boolean> {
  try {
    await identity.revokeInvitation(handle);
  } catch (error) {
    if (!(error instanceof IdentityNotFound)) return false;
  }
  try {
    await store.clearHandle(db, id, handle);
  } catch {
    return false;
  }
  return true;
}

/** `identity.expire-invitations` (hourly): expiry, stale `pending` sends, and the provider revokes still owed. */
@Injectable()
export class InvitationJobs {
  constructor(
    @Inject(INVITATION_ADMIN_STORE) private readonly store: InvitationAdminStorePort,
    @Inject(DATABASE) private readonly database: Pick<Database, 'db' | 'uow'>,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(INVITATION_JOB_OPTIONS) private readonly options: InvitationJobOptions,
  ) {}

  async run(): Promise<ExpireOutcome> {
    let expired = 0;
    for (;;) {
      const due = await this.store.dueForExpiry(this.database.db, BATCH);
      if (due.length === 0) break;
      let progressed = 0;
      for (const id of due) {
        if (await this.database.uow.run((tx) => this.store.expire(tx, id))) progressed += 1;
      }
      expired += progressed;
      if (progressed === 0 || due.length < BATCH) break;
    }
    const staleSends = await this.database.uow.run((tx) =>
      this.store.failStaleSends(tx, this.options.sendStaleMin),
    );
    let revoked = 0;
    let owed = 0;
    for (const { id, handle } of await this.store.revokesOwed(this.database.db, BATCH)) {
      if (await settleProviderRevoke(this.identity, this.store, this.database.db, id, handle)) revoked += 1;
      else owed += 1;
    }
    return { expired, staleSends, revoked, revokesOwed: owed };
  }
}
