import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AdminUsersService, IDENTITY_PORT, IdentityNotFound } from '../../identity/index.js';
import type { IdentityPort } from '../../identity/index.js';
import type { DbTx } from '../../../platform/db/index.js';
import type { AccountAdmin, AccountIdentity, AccountStatus, AccountView } from '../application/account-lifecycle-ports.js';

/**
 * The identity module's admin service, found when first used: the composition root imports the identity module itself,
 * and this module has no import of it (lifecycle only calls its two lifecycle-only operations, SB-D12).
 */
@Injectable()
export class IdentityAccountAdmin implements AccountAdmin {
  constructor(@Inject(ModuleRef) private readonly modules: ModuleRef) {}

  setStatus(
    tx: DbTx,
    input: { actorId: string; userId: string; status: AccountStatus; expectedVersion: number },
  ): Promise<AccountView> {
    return this.modules.get(AdminUsersService, { strict: false }).setStatus(tx, input);
  }
}

/** The identity port of the worker's identity module; a provider that has no such object is already done. */
@Injectable()
export class IdentityProviderAccounts implements AccountIdentity {
  constructor(@Inject(ModuleRef) private readonly modules: ModuleRef) {}

  private port(): IdentityPort {
    return this.modules.get<IdentityPort>(IDENTITY_PORT, { strict: false });
  }

  async revokeSessions(idpSubject: string): Promise<void> {
    await this.port().revokeSessions(idpSubject).catch(ignoreMissing);
  }

  async deleteUser(idpSubject: string): Promise<void> {
    await this.port().deleteUser(idpSubject).catch(ignoreMissing);
  }

  async revokeInvitation(idpInvitationId: string): Promise<void> {
    await this.port().revokeInvitation(idpInvitationId).catch(ignoreMissing);
  }
}

function ignoreMissing(error: unknown): void {
  if (!(error instanceof IdentityNotFound)) throw error;
}
