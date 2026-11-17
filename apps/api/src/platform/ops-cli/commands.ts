import { and, asc, eq, gt, isNotNull, ne, sql } from 'drizzle-orm';
import { adminAlerts, auditEvents } from '../../database/schema/audit.js';
import { platformSettings } from '../../database/schema/identity.js';
import { deletionRuns } from '../../database/schema/lifecycle.js';
import { keyEvents, providerKeys } from '../../database/schema/provider-keys.js';
import type { AuditAction } from '../../modules/audit/index.js';
import type { Database, DbTx } from '../db/index.js';
import { lockXact } from '../db/index.js';
import { enqueue } from '../jobs/enqueue.js';
import type { PgBoss } from 'pg-boss';
import { newId } from '../shared-kernel/index.js';
import { rewrapRow } from './kek-crypto.js';
import type { Keys } from './kek-crypto.js';

// The SQL of the four commands. Every one writes its audit event (`actor_type = 'operator'`) in the transaction of the
// change itself, and returns counts only: no key, no ciphertext, no e-mail address and no identifier leaves here.

export interface OpsResult {
  readonly counts: Readonly<Record<string, number>>;
  /** False when the command did less than asked (rows it could not rewrap, a run it could not resume). */
  readonly ok: boolean;
}

const result = (counts: Record<string, number>, ok: boolean): OpsResult => ({ counts, ok });

type Outcome = 'allowed' | 'failed';

async function auditOperator(
  tx: DbTx,
  action: AuditAction,
  objectType: string,
  objectId: string | null,
  outcome: Outcome,
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: newId(),
    actorId: null,
    actorType: 'operator',
    action,
    objectType,
    objectId,
    outcome,
  });
}

/** `first-admin:reopen`: clears the once-only marker, so the owner e-mail can be linked as first administrator again. */
export async function firstAdminReopen(database: Pick<Database, 'uow'>): Promise<OpsResult> {
  return database.uow.run(async (tx) => {
    await lockXact(tx, 'admin-invariant');
    await tx.insert(platformSettings).values({ id: 1 }).onConflictDoNothing();
    const cleared = await tx
      .update(platformSettings)
      .set({ firstAdminSeededAt: null, updatedAt: sql`now()` })
      .where(and(eq(platformSettings.id, 1), isNotNull(platformSettings.firstAdminSeededAt)))
      .returning({ id: platformSettings.id });
    await auditOperator(tx, 'first_admin.reopened', 'platform_settings', null, 'allowed');
    return { counts: { reopened: cleared.length }, ok: true };
  });
}

/** `keys:disable-all` (incident runbook): every live key becomes `disabled`; nothing is deleted or revoked beyond that. */
export async function keysDisableAll(database: Pick<Database, 'uow'>): Promise<OpsResult> {
  return database.uow.run(async (tx) => {
    const disabled = await tx
      .update(providerKeys)
      .set({ status: 'disabled', disabledAt: sql`now()`, updatedAt: sql`now()` })
      .where(ne(providerKeys.status, 'disabled'))
      .returning({ id: providerKeys.id, ownerId: providerKeys.ownerId, provider: providerKeys.provider });
    for (const row of disabled) {
      await tx
        .insert(keyEvents)
        .values({ id: newId(), ownerId: row.ownerId, keyId: row.id, provider: row.provider, kind: 'disabled_by_operator' });
    }
    await auditOperator(tx, 'key.disabled_all', 'provider_key', null, 'allowed');
    const raised = await tx
      .insert(adminAlerts)
      .values({ id: newId(), kind: 'keys_disabled_all', subjectUserId: null, counts: { keys: disabled.length }, dedupeKey: 'keys_disabled_all:-' })
      .onConflictDoNothing()
      .returning({ id: adminAlerts.id });
    return { counts: { disabled: disabled.length, alerts_raised: raised.length }, ok: true };
  });
}

export interface RewrapKeys {
  readonly privateKeys: Keys;
  readonly publicKeys: Keys;
  readonly active: number;
}

const REWRAP_BATCH = 50;

const sealedColumns = {
  id: providerKeys.id,
  ownerId: providerKeys.ownerId,
  provider: providerKeys.provider,
  version: providerKeys.version,
  ciphertext: providerKeys.ciphertext,
  nonce: providerKeys.nonce,
  wrappedDek: providerKeys.wrappedDek,
  kekVersion: providerKeys.kekVersion,
};

/**
 * `kek:rewrap`: every row whose `kek_version` is not the active one gets its data key wrapped again, one row and one
 * transaction at a time, with the row locked and re-read first. The row's own `kek_version` is the progress mark, so a
 * killed run, or a second one, simply continues with what is left; a row that cannot be rewrapped (no private key for
 * its version, or it does not open) is counted, left untouched and makes the command fail.
 */
export async function kekRewrap(database: Pick<Database, 'uow'>, keys: RewrapKeys): Promise<OpsResult> {
  const counts = { rewrapped: 0, failed: 0, already_current: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const batch = await database.uow.run((tx) =>
      tx
        .select({ id: providerKeys.id })
        .from(providerKeys)
        .where(and(ne(providerKeys.kekVersion, keys.active), gt(providerKeys.id, after)))
        .orderBy(asc(providerKeys.id))
        .limit(REWRAP_BATCH),
    );
    if (batch.length === 0) break;
    for (const { id } of batch) {
      const outcome = await database.uow.run(async (tx) => {
        const [row] = await tx.select(sealedColumns).from(providerKeys).where(eq(providerKeys.id, id)).for('update');
        if (row === undefined || row.kekVersion === keys.active) return 'already_current' as const;
        const result = rewrapRow(row, keys.privateKeys, keys.publicKeys, keys.active);
        if (!result.ok) return 'failed' as const;
        const written = await tx
          .update(providerKeys)
          .set({ wrappedDek: result.wrappedDek, kekVersion: keys.active })
          .where(and(eq(providerKeys.id, id), eq(providerKeys.kekVersion, row.kekVersion)))
          .returning({ id: providerKeys.id });
        if (written.length !== 1) return 'already_current' as const;
        await tx
          .insert(keyEvents)
          .values({ id: newId(), ownerId: row.ownerId, keyId: row.id, provider: row.provider, kind: 'rewrapped' });
        return 'rewrapped' as const;
      });
      counts[outcome] += 1;
    }
    after = batch[batch.length - 1]?.id ?? after;
  }
  const ok = counts.failed === 0;
  await database.uow.run((tx) => auditOperator(tx, 'kek.rewrapped', 'provider_key', null, ok ? 'allowed' : 'failed'));
  return { counts, ok };
}

const RUN_QUEUE = { account: 'lifecycle.account-erasure', campaign: 'lifecycle.campaign-deletion' } as const;
type RunKind = keyof typeof RUN_QUEUE;

/** `erasure:resume <runId>`: a `stuck` run goes back to `running` with a clean attempt count and is queued again. */
export async function erasureResume(
  database: Pick<Database, 'uow'>,
  boss: Pick<PgBoss, 'send'>,
  runId: string,
): Promise<OpsResult> {
  return database.uow.run(async (tx) => {
    const [run] = await tx
      .select({ kind: deletionRuns.kind, subjectId: deletionRuns.subjectId, state: deletionRuns.state })
      .from(deletionRuns)
      .where(eq(deletionRuns.id, runId))
      .for('update');
    if (run === undefined) {
      await auditOperator(tx, 'erasure.resumed', 'deletion_run', null, 'failed');
      return result({ resumed: 0, not_found: 1 }, false);
    }
    const objectType = run.kind === 'account' ? 'user' : 'campaign';
    if (run.state !== 'stuck') {
      await auditOperator(tx, 'erasure.resumed', objectType, run.subjectId, 'failed');
      return result({ resumed: 0, not_stuck: 1 }, false);
    }
    await tx
      .update(deletionRuns)
      .set({ state: 'running', attempts: 0, notBefore: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'stuck')));
    await enqueue(boss, tx, RUN_QUEUE[run.kind as RunKind], { runId });
    await auditOperator(tx, 'erasure.resumed', objectType, run.subjectId, 'allowed');
    return result({ resumed: 1 }, true);
  });
}
