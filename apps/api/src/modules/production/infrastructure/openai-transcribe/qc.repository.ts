import { and, eq, sql } from 'drizzle-orm';
import { providerKeys } from '../../../../database/schema/provider-keys.js';
import type { DbTx } from '../../../../platform/db/index.js';
import type { QcRepository, QcRunContext, QcSettlement } from '../../application/qc-ports.js';
import type { SealedKeyRow } from '../../application/worker/ports.js';

const REASON_MAX = 300;
const clip = (text: string): string =>
  text.length <= REASON_MAX ? text : text.slice(0, REASON_MAX);

interface RunSqlRow {
  id: string;
  owner_id: string;
  video_job_id: string;
  state: string;
  key_id: string | null;
  key_version: number | null;
  call_count: number;
  clip_state: string;
  campaign_id: string;
  campaign_active: boolean;
  storage_key: string | null;
  segment_revision: number;
  current_revision: number | null;
  dialogue: string | null;
}

function sealedOf(row: typeof providerKeys.$inferSelect): SealedKeyRow {
  return {
    id: row.id,
    ownerId: row.ownerId,
    provider: row.provider as SealedKeyRow['provider'],
    status: row.status as SealedKeyRow['status'],
    version: row.version,
    sealed: {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      wrappedDek: row.wrappedDek,
      kekVersion: row.kekVersion,
    },
  };
}

/** SQL access to the QC runs the worker settles (the column contract of SB §3.5, migration M0010). */
export class SqlQcRepository implements QcRepository {
  async findRun(tx: DbTx, runId: string): Promise<QcRunContext | null> {
    const result = await tx.execute(
      sql`select q.id::text, q.owner_id::text, q.video_job_id::text, q.state, q.key_id::text, q.key_version, q.call_count,
                 j.state as clip_state, j.campaign_id::text, (c.state = 'active') as campaign_active,
                 m.storage_key, j.segment_revision, s.revision as current_revision, s.dialogue
          from qc_runs q
          join video_jobs j on j.id = q.video_job_id
          join campaigns c on c.id = j.campaign_id
          left join media_objects m on m.id = j.output_media_id
          left join brief_segments s on s.id = j.segment_id
          where q.id = ${runId}`,
    );
    const row = result.rows[0] as RunSqlRow | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      ownerId: row.owner_id,
      videoJobId: row.video_job_id,
      state: row.state,
      keyId: row.key_id,
      keyVersion: row.key_version,
      callCount: row.call_count,
      clipState: row.clip_state,
      campaignId: row.campaign_id,
      campaignActive: row.campaign_active,
      storageKey: row.storage_key,
      segmentRevision: row.segment_revision,
      currentRevision: row.current_revision,
      dialogue: row.dialogue,
    };
  }

  /** Reads the sealed columns: the worker role is the only one granted them (M0004). */
  async findOwnerKey(tx: DbTx, ownerId: string): Promise<SealedKeyRow | null> {
    const rows = await tx
      .select()
      .from(providerKeys)
      .where(and(eq(providerKeys.ownerId, ownerId), eq(providerKeys.provider, 'openai')));
    return rows[0] === undefined ? null : sealedOf(rows[0]);
  }

  async findKey(tx: DbTx, keyId: string): Promise<SealedKeyRow | null> {
    const rows = await tx.select().from(providerKeys).where(eq(providerKeys.id, keyId));
    return rows[0] === undefined ? null : sealedOf(rows[0]);
  }

  async startCall(tx: DbTx, runId: string): Promise<boolean> {
    const result = await tx.execute(
      sql`update qc_runs set call_count = call_count + 1, updated_at = now()
          where id = ${runId} and state = 'submitting' and call_count = 0 returning id`,
    );
    return result.rows.length === 1;
  }

  async settle(tx: DbTx, runId: string, settlement: QcSettlement): Promise<boolean> {
    const result = await tx.execute(
      sql`update qc_runs
             set state = 'completed', qc_state = ${settlement.qcState},
                 reason = ${settlement.reason === null ? null : clip(settlement.reason)},
                 word_error_rate = ${settlement.wordErrorRate}::numeric,
                 last_error_code = ${settlement.errorCode === null ? null : settlement.errorCode.slice(0, 64)},
                 updated_at = now()
           where id = ${runId} and state = 'submitting' returning id`,
    );
    return result.rows.length === 1;
  }
}
