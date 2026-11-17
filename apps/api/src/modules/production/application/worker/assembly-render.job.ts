import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { assemblyClips, assemblyJobs } from '../../../../database/schema/production-assembly.js';
import { campaigns } from '../../../../database/schema/campaigns.js';
import { mediaObjects } from '../../../../database/schema/media.js';
import { videoJobs } from '../../../../database/schema/production.js';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database, DbTx } from '../../../../platform/db/index.js';
import { campaignKey } from '../../../media/index.js';
import type { StoragePort } from '../../../media/index.js';
import { PRODUCTION_STORAGE } from './ports.js';
import type { JobLog } from './ports.js';
import {
  ASSEMBLY_MEDIA,
  ASSEMBLY_PORT,
  ASSEMBLY_WORKER_CONFIG,
  AssemblyRenderError,
} from './assembly-ports.js';
import type {
  AssemblyCause,
  AssemblyMedia,
  AssemblyPort,
  AssemblyWorkerConfig,
} from './assembly-ports.js';

export type AssemblyRenderOutcome = 'done' | 'failed' | 'ignored';

const ACTIVE = sql`('fetching', 'rendering', 'saving')`;

export const ASSEMBLY_MESSAGES = {
  render_failed: 'The video could not be rendered. Try assembling again.',
  input_unavailable: 'One of the clips could not be read. Check the clips, then assemble again.',
  timeout: 'The render took too long. Try assembling again.',
  interrupted: 'The render was interrupted too many times. Try assembling again.',
  size: 'The finished video is larger than the allowed size. Try assembling again.',
  cancelled: 'The campaign was deleted, so the video was not rendered.',
} as const;

type Cause = AssemblyCause | 'cancelled_campaign_deleted';

/** A render slot: at most `limit` renders run in this process, the rest wait for one. */
class Slots {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async hold<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.running -= 1;
      else next();
    }
  }
}

interface Claim {
  readonly ownerId: string;
  readonly campaignId: string;
  /** The claim's number: it fences every later write, so a run that lost its lease cannot move the job. */
  readonly attempt: number;
}

interface ClipFile {
  readonly position: number;
  readonly storageKey: string | null;
}

/**
 * `production.assembly-render` (ARCHITECTURE §5.7): the claim moves the job to `fetching` under a lease and counts the
 * attempt; the clips are copied to a private local directory, rendered by the AssemblyPort (`rendering`), the output is put
 * under its fixed key and registered with the job's completion in one guarded transaction (`saving`, then `done`). A
 * heartbeat keeps the lease while the work runs. A worker that dies leaves the job in a working state with its lease
 * running out: the next run (the queue's retry, or the recovery sweep's message) takes it over from `fetching`, the object
 * has the same key every time, so there is one output. A fault that trying again would not fix ends the job `failed` with
 * its cause class and message; anything else is thrown, the lease is released, and the queue retries.
 */
@Injectable()
export class AssemblyRenderJob {
  private readonly slots: Slots;

  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(ASSEMBLY_PORT) private readonly renderer: AssemblyPort,
    @Inject(PRODUCTION_STORAGE) private readonly storage: StoragePort,
    @Inject(ASSEMBLY_MEDIA) private readonly media: AssemblyMedia,
    @Inject(ASSEMBLY_WORKER_CONFIG) private readonly config: AssemblyWorkerConfig,
  ) {
    this.slots = new Slots(config.concurrency);
  }

  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<AssemblyRenderOutcome> {
    const jobId = (job.data as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string')
      throw new TypeError('production.assembly-render job has no jobId');
    const outcome = await this.slots.hold(() => this.run(jobId, log));
    log.info(
      { module: 'production', outcome: outcome === 'failed' ? 'error' : 'ok', jobId },
      `assembly render: ${outcome}`,
    );
    return outcome;
  }

  async run(jobId: string, log: JobLog): Promise<AssemblyRenderOutcome> {
    const claim = await this.database.uow.run((tx) => this.claim(tx, jobId));
    if (claim === 'failed' || claim === 'ignored') return claim;

    const lost = new AbortController();
    const heartbeat = setInterval(
      () => {
        this.database.uow
          .run((tx) => this.renew(tx, jobId, claim.attempt))
          .then((held) => {
            if (!held) lost.abort();
          })
          .catch(() => undefined);
      },
      Math.max(1000, Math.floor((this.config.leaseSec * 1000) / 3)),
    );
    // The directory is the job's own: a run that died earlier leaves one, and the next run starts it clean.
    const directory = join(tmpdir(), `assembly-${jobId}`);
    try {
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return await this.work(jobId, claim, directory, lost.signal, log);
    } catch (error) {
      if (lost.signal.aborted) return 'ignored';
      if (error instanceof AssemblyRenderError)
        return this.fail(jobId, claim, error.causeClass, ASSEMBLY_MESSAGES[error.causeClass], log);
      // Not the job's fault (storage, database, the binary): free the lease so the queue's retry can take over at once.
      await this.database.uow
        .run((tx) => this.release(tx, jobId, claim.attempt))
        .catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async work(
    jobId: string,
    claim: Claim,
    directory: string,
    signal: AbortSignal,
    log: JobLog,
  ): Promise<AssemblyRenderOutcome> {
    const clips = await this.database.uow.run((tx) => this.clipsOf(tx, jobId));
    if (clips.length === 0 || clips.some((clip) => clip.storageKey === null)) {
      return this.fail(jobId, claim, 'input_unavailable', ASSEMBLY_MESSAGES.input_unavailable, log);
    }
    const files: string[] = [];
    for (const clip of clips) {
      const file = join(directory, `clip-${String(clip.position)}.mp4`);
      await this.fetch(clip.storageKey as string, file);
      files.push(file);
    }
    if (
      !(await this.database.uow.run((tx) =>
        this.advance(tx, jobId, claim.attempt, 'fetching', 'rendering'),
      ))
    )
      return 'ignored';

    const output = join(directory, 'final.mp4');
    let reported = 0;
    await this.renderer.render({ clips: files, openingFrame: null, output, signal }, (progress) => {
      if (progress.fraction - reported >= 0.25 || progress.fraction === 1) {
        reported = progress.fraction;
        log.info(
          {
            module: 'production',
            outcome: 'ok',
            jobId,
            progress: Math.round(progress.fraction * 100),
          },
          'assembly render progress',
        );
      }
    });
    if (
      !(await this.database.uow.run((tx) =>
        this.advance(tx, jobId, claim.attempt, 'rendering', 'saving'),
      ))
    )
      return 'ignored';

    const storageKey = campaignKey(claim.ownerId, claim.campaignId, 'final', jobId, 'mp4');
    const bytes = await this.put(storageKey, output);
    if (bytes === 'too_large')
      return this.fail(jobId, claim, 'render_failed', ASSEMBLY_MESSAGES.size, log);
    const done = await this.database.uow.run((tx) =>
      this.complete(tx, jobId, claim, storageKey, bytes),
    );
    if (done === 'refused') {
      await this.discard(storageKey, jobId, log);
      return 'ignored';
    }
    return 'done';
  }

  /** Copies one stored clip to a local file; a clip that is gone is an input fault, anything else is retried. */
  private async fetch(storageKey: string, file: string): Promise<void> {
    let body: Awaited<ReturnType<StoragePort['get']>>;
    try {
      body = await this.storage.get(storageKey);
    } catch (error) {
      if ((error as { name?: string }).name === 'StorageNotFound')
        throw new AssemblyRenderError('input_unavailable', 'a clip is missing from storage');
      throw error;
    }
    try {
      await pipeline(body, createWriteStream(file, { mode: 0o600 }));
    } finally {
      body.destroy();
    }
  }

  /** The put; an object already there from an earlier run of this same job is the output. */
  private async put(storageKey: string, file: string): Promise<number | 'too_large'> {
    const body = createReadStream(file);
    try {
      return (await this.storage.put(storageKey, body, 'video/mp4', this.config.outputMaxBytes))
        .bytes;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'StorageTooLarge') return 'too_large';
      if (name !== 'StorageKeyExists') throw error;
      const listed = await this.storage.list(storageKey);
      const own = listed.objects.find((object) => object.key === storageKey);
      if (own === undefined) throw error;
      return own.bytes;
    } finally {
      body.destroy();
    }
  }

  private async discard(storageKey: string, jobId: string, log: JobLog): Promise<void> {
    // Only an output nobody registered is removed; the key is the job's own, so a run that won it keeps its object.
    const registered = await this.database.uow.run(async (tx) => {
      const [row] = await tx
        .select({ id: mediaObjects.id })
        .from(mediaObjects)
        .where(eq(mediaObjects.storageKey, storageKey));
      return row !== undefined;
    });
    if (registered) return;
    const open = await this.database.uow.run(async (tx) => {
      const [row] = await tx
        .select({ state: assemblyJobs.state })
        .from(assemblyJobs)
        .where(eq(assemblyJobs.id, jobId));
      return row !== undefined && ['fetching', 'rendering', 'saving'].includes(row.state);
    });
    if (open) return;
    await this.storage.delete(storageKey).catch(() => {
      // The campaign deletion run removes whatever is left under the campaign's prefix.
      log.warn(
        { module: 'production', outcome: 'error', jobId },
        'discarded assembly output could not be deleted',
      );
    });
  }

  /**
   * Takes the job: `pending` or `queued`, or a working state whose lease ran out, becomes `fetching` with a new lease and
   * one more attempt. A job past its attempts ends `render_failed`; one whose campaign is going away ends cancelled.
   */
  private async claim(tx: DbTx, jobId: string): Promise<Claim | 'failed' | 'ignored'> {
    const taken = await tx.execute(
      sql`update assembly_jobs set state = 'fetching', lease_until = now() + make_interval(secs => ${this.config.leaseSec}),
            attempts = attempts + 1, updated_at = now()
          where id = ${jobId} and attempts < ${this.config.maxAttempts}
            and (state in ('pending', 'queued') or (state in ${ACTIVE} and coalesce(lease_until, '-infinity') < now()))
          returning owner_id::text as owner_id, campaign_id::text as campaign_id, attempts`,
    );
    const row = taken.rows[0] as
      { owner_id: string; campaign_id: string; attempts: number } | undefined;
    if (row === undefined) {
      const spent = await tx.execute(
        sql`update assembly_jobs set state = 'failed', cause_class = 'render_failed', cause_message = ${ASSEMBLY_MESSAGES.interrupted},
              lease_until = null, updated_at = now()
            where id = ${jobId} and attempts >= ${this.config.maxAttempts}
              and (state in ('pending', 'queued') or (state in ${ACTIVE} and coalesce(lease_until, '-infinity') < now()))
            returning id`,
      );
      return spent.rows.length === 1 ? 'failed' : 'ignored';
    }
    const claim: Claim = {
      ownerId: row.owner_id,
      campaignId: row.campaign_id,
      attempt: row.attempts,
    };
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, claim.campaignId), eq(campaigns.state, 'active')));
    if (campaign === undefined) {
      await this.finish(
        tx,
        jobId,
        claim.attempt,
        'cancelled_campaign_deleted',
        ASSEMBLY_MESSAGES.cancelled,
      );
      return 'failed';
    }
    return claim;
  }

  /** The clips in order with the object each was stored under (`null` when the clip has no registered object). */
  private async clipsOf(tx: DbTx, jobId: string): Promise<readonly ClipFile[]> {
    const rows = await tx
      .select({ position: assemblyClips.position, storageKey: mediaObjects.storageKey })
      .from(assemblyClips)
      .innerJoin(videoJobs, eq(videoJobs.id, assemblyClips.videoJobId))
      .leftJoin(
        mediaObjects,
        and(eq(mediaObjects.id, videoJobs.outputMediaId), eq(mediaObjects.state, 'ready')),
      )
      .where(eq(assemblyClips.assemblyJobId, jobId))
      .orderBy(asc(assemblyClips.position));
    return rows;
  }

  /** The heartbeat: extends the lease while this claim still holds the job. */
  private async renew(tx: DbTx, jobId: string, attempt: number): Promise<boolean> {
    const moved = await tx.execute(
      sql`update assembly_jobs set lease_until = now() + make_interval(secs => ${this.config.leaseSec}), updated_at = now()
          where id = ${jobId} and attempts = ${attempt} and state in ${ACTIVE} returning id`,
    );
    return moved.rows.length === 1;
  }

  private async release(tx: DbTx, jobId: string, attempt: number): Promise<void> {
    await tx.execute(
      sql`update assembly_jobs set lease_until = now(), updated_at = now() where id = ${jobId} and attempts = ${attempt} and state in ${ACTIVE}`,
    );
  }

  private async advance(
    tx: DbTx,
    jobId: string,
    attempt: number,
    from: string,
    to: string,
  ): Promise<boolean> {
    const moved = await tx.execute(
      sql`update assembly_jobs set state = ${to}, lease_until = now() + make_interval(secs => ${this.config.leaseSec}), updated_at = now()
          where id = ${jobId} and attempts = ${attempt} and state = ${from} returning id`,
    );
    return moved.rows.length === 1;
  }

  /**
   * Guard after the put: this claim still holds the job in `saving` and the campaign is active; then the output is
   * registered (quota and row) and the job is `done` with it, in this one transaction.
   */
  private async complete(
    tx: DbTx,
    jobId: string,
    claim: Claim,
    storageKey: string,
    bytes: number,
  ): Promise<'done' | 'refused'> {
    const held = await tx.execute(
      sql`select j.id from assembly_jobs j join campaigns c on c.id = j.campaign_id
          where j.id = ${jobId} and j.attempts = ${claim.attempt} and j.state = 'saving' and c.state = 'active' for update of j`,
    );
    if (held.rows.length === 0) return 'refused';
    await this.media.registerFinal(tx, {
      id: jobId,
      ownerId: claim.ownerId,
      campaignId: claim.campaignId,
      storageKey,
      bytes,
    });
    await tx.execute(
      sql`update assembly_jobs set state = 'done', output_media_id = ${jobId}, cause_class = null, cause_message = null, lease_until = null, updated_at = now()
          where id = ${jobId}`,
    );
    return 'done';
  }

  private async finish(
    tx: DbTx,
    jobId: string,
    attempt: number,
    cause: Cause,
    message: string,
  ): Promise<boolean> {
    const moved = await tx.execute(
      sql`update assembly_jobs set state = 'failed', cause_class = ${cause}, cause_message = ${message}, lease_until = null, updated_at = now()
          where id = ${jobId} and attempts = ${attempt} and state in ${ACTIVE} returning id`,
    );
    return moved.rows.length === 1;
  }

  private async fail(
    jobId: string,
    claim: Claim,
    cause: Cause,
    message: string,
    log: JobLog,
  ): Promise<AssemblyRenderOutcome> {
    const failed = await this.database.uow.run((tx) =>
      this.finish(tx, jobId, claim.attempt, cause, message),
    );
    if (failed)
      log.warn(
        { module: 'production', outcome: 'error', jobId, causeClass: cause },
        'assembly render failed',
      );
    return failed ? 'failed' : 'ignored';
  }
}
