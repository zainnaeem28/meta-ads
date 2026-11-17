import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { keyEvents, providerKeys } from '../../../../database/schema/provider-keys.js';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database, DbTx } from '../../../../platform/db/index.js';
import { newId } from '../../../../platform/shared-kernel/index.js';
import { AuditService } from '../../../audit/index.js';
import { KEY_AUTH_THRESHOLD } from '../../application/worker/ports.js';
import type { KeyAuthReporter } from '../../application/worker/ports.js';

type KeyEventKind = 'validated_by_job' | 'auth_failed' | 'disabled';

/**
 * The worker's report of what a OpenAI transcription told about a key (ARCHITECTURE §5.2): a 401 counts toward disabling it
 * (`KEY_AUTO_DISABLE_THRESHOLD` in a row), a success resets the count and lets the first one turn `untested` into
 * `active`. The version is part of the match, so a report about a key that has since been replaced counts for nothing.
 * Same transitions as `ProviderKeysService.recordAuthResult`, which the worker process does not carry.
 */
@Injectable()
export class OpenAiKeyAuthReporter implements KeyAuthReporter {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(KEY_AUTH_THRESHOLD) private readonly threshold: number,
  ) {}

  async report(keyId: string, version: number, ok: boolean): Promise<void> {
    await this.database.uow.run((tx) =>
      ok ? this.succeeded(tx, keyId, version) : this.failed(tx, keyId, version),
    );
  }

  private async succeeded(tx: DbTx, keyId: string, version: number): Promise<void> {
    const live = and(eq(providerKeys.id, keyId), eq(providerKeys.version, version));
    const reset = {
      consecutiveAuthFailures: 0,
      lastValidatedAt: sql`now()`,
      updatedAt: sql`now()`,
    };
    const activated = await tx
      .update(providerKeys)
      .set({ ...reset, status: 'active' })
      .where(and(live, eq(providerKeys.status, 'untested')))
      .returning({ ownerId: providerKeys.ownerId });
    if (activated[0] !== undefined) {
      await this.event(tx, activated[0].ownerId, keyId, 'validated_by_job');
      return;
    }
    await tx
      .update(providerKeys)
      .set(reset)
      .where(and(live, eq(providerKeys.status, 'active')));
  }

  private async failed(tx: DbTx, keyId: string, version: number): Promise<void> {
    const next = sql`${providerKeys.consecutiveAuthFailures} + 1`;
    const reached = sql`${next} >= ${this.threshold}`;
    const rows = await tx
      .update(providerKeys)
      .set({
        consecutiveAuthFailures: next,
        status: sql`case when ${reached} then 'disabled' else ${providerKeys.status} end`,
        disabledAt: sql`case when ${reached} then now() else ${providerKeys.disabledAt} end`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(providerKeys.id, keyId),
          eq(providerKeys.version, version),
          ne(providerKeys.status, 'disabled'),
        ),
      )
      .returning({ ownerId: providerKeys.ownerId, status: providerKeys.status });
    const row = rows[0];
    if (row === undefined) return;
    await this.event(tx, row.ownerId, keyId, 'auth_failed');
    if (row.status !== 'disabled') return;
    await this.event(tx, row.ownerId, keyId, 'disabled');
    await this.audit.record(tx, {
      actorId: null,
      actorType: 'system',
      action: 'key.disabled',
      objectType: 'provider_key',
      objectId: keyId,
      outcome: 'allowed',
    });
  }

  private async event(tx: DbTx, ownerId: string, keyId: string, kind: KeyEventKind): Promise<void> {
    await tx.insert(keyEvents).values({ id: newId(), ownerId, keyId, provider: 'openai', kind });
  }
}
