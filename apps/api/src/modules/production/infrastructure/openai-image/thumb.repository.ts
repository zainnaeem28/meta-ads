import { and, eq, sql } from 'drizzle-orm';
import { providerKeys } from '../../../../database/schema/provider-keys.js';
import type { DbTx } from '../../../../platform/db/index.js';
import type {
  ThumbCause,
  ThumbJobContext,
  ThumbRepository,
} from '../../application/thumb-ports.js';
import type { SealedKeyRow } from '../../application/worker/ports.js';

const MESSAGE_MAX = 300;
const clip = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max);

interface JobSqlRow {
  id: string;
  owner_id: string;
  campaign_id: string;
  callout_text: string;
  provider_model: string;
  state: string;
  key_id: string | null;
  key_version: number | null;
  call_count: number;
  campaign_active: boolean;
}

/** SQL access to the thumbstopper jobs the worker settles (the column contract of SB §3.5, migration M0012). */
export class SqlThumbRepository implements ThumbRepository {
  async findJob(tx: DbTx, jobId: string): Promise<ThumbJobContext | null> {
    const result = await tx.execute(
      sql`select t.id::text, t.owner_id::text, t.campaign_id::text, t.callout_text, t.provider_model, t.state, t.key_id::text, t.key_version, t.call_count,
                 (c.state = 'active') as campaign_active
          from thumbstopper_jobs t
          join campaigns c on c.id = t.campaign_id
          where t.id = ${jobId}`,
    );
    const row = result.rows[0] as JobSqlRow | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      ownerId: row.owner_id,
      campaignId: row.campaign_id,
      calloutText: row.callout_text,
      providerModel: row.provider_model,
      state: row.state,
      keyId: row.key_id,
      keyVersion: row.key_version,
      callCount: row.call_count,
      campaignActive: row.campaign_active,
    };
  }

  /** Reads the sealed columns: the worker role is the only one granted them (M0004). */
  async findKey(tx: DbTx, keyId: string): Promise<SealedKeyRow | null> {
    const rows = await tx
      .select()
      .from(providerKeys)
      .where(and(eq(providerKeys.id, keyId)));
    const row = rows[0];
    if (row === undefined) return null;
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

  async failPending(tx: DbTx, jobId: string, cause: ThumbCause, message: string): Promise<boolean> {
    const result = await tx.execute(
      sql`update thumbstopper_jobs set state = 'failed', cause_class = ${cause}, cause_message = ${clip(message, MESSAGE_MAX)}, updated_at = now()
          where id = ${jobId} and state = 'pending' returning id`,
    );
    return result.rows.length === 1;
  }

  async startCall(tx: DbTx, jobId: string): Promise<boolean> {
    const result = await tx.execute(
      sql`update thumbstopper_jobs set call_count = call_count + 1, updated_at = now()
          where id = ${jobId} and state = 'submitting' and call_count = 0 returning id`,
    );
    return result.rows.length === 1;
  }

  async fail(
    tx: DbTx,
    jobId: string,
    cause: ThumbCause,
    message: string,
    errorCode: string | null,
  ): Promise<boolean> {
    const result = await tx.execute(
      sql`update thumbstopper_jobs
             set state = 'failed', cause_class = ${cause}, cause_message = ${clip(message, MESSAGE_MAX)},
                 last_error_code = ${errorCode === null ? null : clip(errorCode, 64)}, updated_at = now()
           where id = ${jobId} and state = 'submitting' returning id`,
    );
    return result.rows.length === 1;
  }

  async complete(
    tx: DbTx,
    job: ThumbJobContext,
    mediaId: string,
    register: (tx: DbTx) => Promise<void>,
  ): Promise<boolean> {
    const guard = await tx.execute(
      sql`select t.id from thumbstopper_jobs t join campaigns c on c.id = t.campaign_id
          where t.id = ${job.id} and t.state = 'submitting' and c.state = 'active' for update of t`,
    );
    if (guard.rows.length === 0) return false;
    await register(tx);
    await tx.execute(
      sql`update thumbstopper_jobs set state = 'completed', output_media_id = ${mediaId}, updated_at = now() where id = ${job.id}`,
    );
    return true;
  }
}
