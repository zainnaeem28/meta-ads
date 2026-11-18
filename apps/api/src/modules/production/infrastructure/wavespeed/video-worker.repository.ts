import { eq, sql } from 'drizzle-orm';
import { briefSegments } from '../../../../database/schema/brief.js';
import { providerKeys, sealedKeyColumns } from '../../../../database/schema/provider-keys.js';
import type { DbTx } from '../../../../platform/db/index.js';
import type {
  CleanupCandidate,
  CopyGuard,
  CopyTarget,
  SealedKeyRow,
  VideoCause,
  VideoJobRow,
  VideoWorkerRepository,
} from '../../application/worker/ports.js';

const MESSAGE_MAX = 300;
const clip = (text: string): string =>
  text.length <= MESSAGE_MAX ? text : text.slice(0, MESSAGE_MAX);
/** The provider keeps a finished output for 7 days; a task older than that is gone and is not asked about (TD-D30). */
const CLEANUP_HORIZON_DAYS = 7;

interface JobSqlRow {
  id: string;
  owner_id: string;
  campaign_id: string;
  segment_id: string;
  segment_revision: number;
  reference_media_id: string | null;
  provider_model: string;
  options: VideoJobRow['options'];
  state: string;
  key_id: string | null;
  key_version: number | null;
  provider_task_id: string | null;
  provider_completed_at: string | null;
  output_media_id: string | null;
}

/** SQL access to the video jobs the worker settles (the column contract of SB §3.5, migration M0010). */
export class SqlVideoWorkerRepository implements VideoWorkerRepository {
  async findJob(tx: DbTx, jobId: string): Promise<VideoJobRow | null> {
    const result = await tx.execute(
      sql`select id::text, owner_id::text, campaign_id::text, segment_id::text, segment_revision, reference_media_id::text,
                 provider_model, options, state, key_id::text, key_version, provider_task_id,
                 provider_completed_at::text, output_media_id::text
          from video_jobs where id = ${jobId}`,
    );
    const row = result.rows[0] as JobSqlRow | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      ownerId: row.owner_id,
      campaignId: row.campaign_id,
      segmentId: row.segment_id,
      segmentRevision: row.segment_revision,
      referenceMediaId: row.reference_media_id,
      providerModel: row.provider_model,
      options: row.options,
      state: row.state,
      keyId: row.key_id,
      keyVersion: row.key_version,
      providerTaskId: row.provider_task_id,
      providerCompletedAt: row.provider_completed_at,
      outputMediaId: row.output_media_id,
    };
  }

  /** Reads the sealed columns: the worker role is the only one granted them (M0004). */
  async findKey(tx: DbTx, keyId: string): Promise<SealedKeyRow | null> {
    const rows = await tx
      .select(sealedKeyColumns)
      .from(providerKeys)
      .where(eq(providerKeys.id, keyId));
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

  async findSegmentText(
    tx: DbTx,
    segmentId: string,
  ): Promise<{ prompt: string; dialogue: string } | null> {
    const rows = await tx
      .select({ prompt: briefSegments.prompt, dialogue: briefSegments.dialogue })
      .from(briefSegments)
      .where(eq(briefSegments.id, segmentId));
    return rows[0] ?? null;
  }

  async campaignActive(tx: DbTx, campaignId: string): Promise<boolean> {
    const result = await tx.execute(
      sql`select 1 from campaigns where id = ${campaignId} and state = 'active'`,
    );
    return result.rows.length === 1;
  }

  async failPending(tx: DbTx, jobId: string, cause: VideoCause, message: string): Promise<boolean> {
    const result = await tx.execute(
      sql`update video_jobs set state = 'failed', cause_class = ${cause}, cause_message = ${clip(message)}, updated_at = now()
          where id = ${jobId} and state = 'pending' returning id`,
    );
    return result.rows.length === 1;
  }

  async startCall(tx: DbTx, jobId: string): Promise<boolean> {
    const result = await tx.execute(
      sql`update video_jobs set call_count = call_count + 1, updated_at = now()
          where id = ${jobId} and state = 'submitting' and call_count = 0 returning id`,
    );
    return result.rows.length === 1;
  }

  async setErrorCode(tx: DbTx, jobId: string, code: string): Promise<void> {
    await tx.execute(
      sql`update video_jobs set last_error_code = ${code.slice(0, 64)}, updated_at = now() where id = ${jobId}`,
    );
  }

  async copyOpen(
    tx: DbTx,
    jobId: string,
    windowHours: number,
  ): Promise<'open' | 'window_passed' | 'not_copying'> {
    const result = await tx.execute(
      sql`select state, output_media_id is not null as copied,
                 provider_completed_at is not null as finished,
                 provider_completed_at < now() - make_interval(hours => ${windowHours}) as passed
          from video_jobs where id = ${jobId}`,
    );
    const row = result.rows[0] as
      { state: string; copied: boolean; finished: boolean; passed: boolean | null } | undefined;
    if (row === undefined || row.state !== 'processing' || !row.finished || row.copied)
      return 'not_copying';
    return row.passed === true ? 'window_passed' : 'open';
  }

  async completeCopy(
    tx: DbTx,
    job: VideoJobRow,
    target: CopyTarget,
    register: (tx: DbTx) => Promise<void>,
  ): Promise<CopyGuard> {
    const guarded = await tx.execute(
      sql`select j.id from video_jobs j join campaigns c on c.id = j.campaign_id
          where j.id = ${job.id} and j.state = 'processing' and j.provider_completed_at is not null
            and j.output_media_id is null and c.state = 'active'
          for update of j for share of c`,
    );
    if (guarded.rows.length === 0) return { kind: 'refused' };
    await register(tx);
    await tx.execute(
      sql`update video_jobs set state = 'completed', output_media_id = ${target.mediaId}, updated_at = now() where id = ${job.id}`,
    );
    await tx.execute(sql`update campaigns set updated_at = now() where id = ${job.campaignId}`);
    return { kind: 'completed' };
  }

  async failCopy(tx: DbTx, jobId: string, message: string): Promise<boolean> {
    const result = await tx.execute(
      sql`update video_jobs set state = 'failed', cause_class = 'output_unreachable', cause_message = ${clip(message)}, updated_at = now()
          where id = ${jobId} and state = 'processing' and provider_completed_at is not null and output_media_id is null returning id`,
    );
    return result.rows.length === 1;
  }

  async markOutputDeleted(tx: DbTx, jobId: string): Promise<void> {
    await tx.execute(
      sql`update video_jobs set provider_output_deleted_at = now(), updated_at = now()
          where id = ${jobId} and provider_output_deleted_at is null`,
    );
  }

  async cleanupCandidates(tx: DbTx, limit: number): Promise<CleanupCandidate[]> {
    const result = await tx.execute(
      sql`select id::text, owner_id::text, key_id::text, provider_task_id
          from video_jobs
          where provider_task_id is not null and provider_output_deleted_at is null
            and created_at > now() - make_interval(days => ${CLEANUP_HORIZON_DAYS})
            and ((state in ('failed', 'cancelled') and deadline_at < now())
              or (state = 'completed' and output_media_id is not null))
          order by created_at limit ${limit}`,
    );
    return (
      result.rows as {
        id: string;
        owner_id: string;
        key_id: string | null;
        provider_task_id: string;
      }[]
    ).map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      keyId: row.key_id,
      providerTaskId: row.provider_task_id,
    }));
  }
}
