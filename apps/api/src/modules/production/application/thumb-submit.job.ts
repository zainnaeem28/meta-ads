import { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { claimWithUserLimit, jobTable } from '../../../platform/jobs/claim.js';
import { UsageService } from '../../usage/index.js';
import type { BillableCall } from '../../usage/index.js';
import { campaignKey } from '../../media/index.js';
import type { StoragePort } from '../../media/index.js';
import { QcKeySession } from './qc-key-session.js';
import { thumbPrompt } from './thumb-callout.js';
import { IMAGE_GEN_PORT, THUMB_CONFIG, THUMB_MEDIA, THUMB_REPOSITORY } from './thumb-ports.js';
import type { GeneratedImage, ImageGenPort, ThumbCause, ThumbConfig, ThumbJobContext, ThumbMedia, ThumbRepository } from './thumb-ports.js';
import { PRODUCTION_STORAGE, ProviderCallFailed, ProviderInvalidResponse } from './worker/ports.js';
import type { JobLog, SealedKeyRow } from './worker/ports.js';

export const THUMB_TABLE = jobTable('thumbstopper_jobs');

export type ThumbOutcome = 'completed' | 'failed' | 'ignored';

interface Refusal {
  readonly cause: ThumbCause;
  readonly message: string;
  readonly errorCode: string | null;
}

const MESSAGES = {
  keyGone: 'The OpenAI key this image used was removed. Add a key in Settings, then try again.',
  keyReplaced: 'Your OpenAI key was replaced while this image waited. Try again.',
  keyDisabled: 'Your OpenAI key is disabled. Enter it again in Settings, then try again.',
  keyWrong: 'The key this image used is not an OpenAI key.',
  keyUnreadable: 'Your OpenAI key could not be read. Enter it again in Settings, then try again.',
  invalid: 'OpenAI returned something that is not a usable image. Try again.',
  unsaved: 'The image was made but could not be saved. Try again.',
  unknown: 'The image could not be made. Check your OpenAI account before trying again.',
  temporary: 'OpenAI was not available. Try again.',
  timeout: 'OpenAI took too long to answer. Try again.',
  configuration: 'OpenAI did not accept the request. Check your key in Settings, then try again.',
  credit: 'Your OpenAI account has no credit left. Add credit, then try again.',
} as const;

/** What the call closure learns, for the usage and key bookkeeping after the job is settled. */
interface CallFacts {
  /** The request left the process: an unbilled refusal is recorded at zero, anything unknown stays counted. */
  usage: 'none' | 'succeeded' | 'rejected' | 'unconfirmed';
  latencyMs: number;
  /** The key the call used, and what it told about it. */
  key: SealedKeyRow | null;
  keyOk: boolean | null;
}

/** The claim guard on the key: the one the job was created with must still exist, be the owner's same-version OpenAI key and not be disabled. */
export function gateThumbKey(job: Pick<ThumbJobContext, 'ownerId' | 'keyId' | 'keyVersion'>, key: SealedKeyRow | null): { ok: true; key: SealedKeyRow } | { ok: false; cause: ThumbCause; message: string } {
  if (job.keyId === null || key === null || key.ownerId !== job.ownerId) return { ok: false, cause: 'key_deleted', message: MESSAGES.keyGone };
  if (key.provider !== 'openai') return { ok: false, cause: 'configuration', message: MESSAGES.keyWrong };
  if (job.keyVersion === null || key.version !== job.keyVersion) return { ok: false, cause: 'key_replaced', message: MESSAGES.keyReplaced };
  if (key.status === 'disabled') return { ok: false, cause: 'configuration', message: MESSAGES.keyDisabled };
  return { ok: true, key };
}

/**
 * `production.thumbstopper-submit` (ARCHITECTURE §5.5): the key check, the claim, then at most one image call. `submitting` is
 * committed before the provider is called; the answer settles the job and its usage event together. A crash in between
 * leaves `submitting`, which the recovery sweep settles as `outcome_unknown`; the call is never repeated. The image is type-checked by the
 * adapter, stored privately under the campaign's prefix and registered as the job completes, in a transaction that checks
 * again that the job was not cancelled (guard after put); a refused guard deletes our own object.
 */
@Injectable()
export class ThumbSubmitJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(THUMB_REPOSITORY) private readonly repository: ThumbRepository,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(QcKeySession) private readonly keys: QcKeySession,
    @Inject(IMAGE_GEN_PORT) private readonly images: ImageGenPort,
    @Inject(PRODUCTION_STORAGE) private readonly storage: Pick<StoragePort, 'put' | 'delete' | 'list'>,
    @Inject(THUMB_MEDIA) private readonly media: ThumbMedia,
    @Inject(THUMB_CONFIG) private readonly config: ThumbConfig,
  ) {}

  /** The queue handler: the job ID is the whole payload. */
  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<ThumbOutcome> {
    const jobId = (job.data as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string') throw new TypeError('production.thumbstopper-submit job has no jobId');
    const outcome = await this.run(jobId, log);
    log.info({ module: 'production', outcome: outcome === 'failed' ? 'error' : 'ok', jobId }, `thumbstopper: ${outcome}`);
    return outcome;
  }

  async run(jobId: string, log: JobLog): Promise<ThumbOutcome> {
    const job = await this.database.uow.run((tx) => this.repository.findJob(tx, jobId));
    if (job === null || job.state !== 'pending') return 'ignored';
    // The campaign is going away: the deletion run cancels the job; nothing is sent.
    if (!job.campaignActive) return 'ignored';
    const key = await this.database.uow.run(async (tx) => (job.keyId === null ? null : this.repository.findKey(tx, job.keyId)));
    const gate = gateThumbKey(job, key);
    if (!gate.ok) return this.refuse(job, { cause: gate.cause, message: gate.message, errorCode: null });
    const claim = await this.database.uow.run((tx) => claimWithUserLimit(tx, THUMB_TABLE, jobId, { limit: null }));
    if (claim.kind !== 'claimed') return 'ignored';

    const facts: CallFacts = { usage: 'none', latencyMs: 0, key: null, keyOk: null };
    let outcome: ThumbOutcome | null;
    try {
      outcome = await this.call(job, gate.key, facts, log);
    } catch {
      // Whatever went wrong is not the user's to fix; a call that may have gone out keeps its estimate counted.
      if (facts.usage === 'none' && facts.key !== null && facts.keyOk === null) facts.usage = 'unconfirmed';
      outcome = await this.settleFailure(job, { cause: 'outcome_unknown', message: MESSAGES.unknown, errorCode: 'thumbstopper_error' }, facts);
    }
    if (facts.key !== null && facts.keyOk !== null) await this.keys.report(facts.key, facts.keyOk, log);
    return outcome ?? 'ignored';
  }

  /** No call was made: the job fails while still `pending` and its reservation is dropped. */
  private async refuse(job: ThumbJobContext, refusal: Refusal): Promise<ThumbOutcome> {
    return this.database.uow.run(async (tx) => {
      if (!(await this.repository.failPending(tx, job.id, refusal.cause, refusal.message))) return 'ignored';
      await this.usage.release(tx, { ownerId: job.ownerId, jobType: 'thumbstopper', jobId: job.id });
      return 'failed';
    });
  }

  /** The one image call and what follows it. `null` when the job left `submitting` under it (cancelled, swept). */
  private async call(job: ThumbJobContext, key: SealedKeyRow, facts: CallFacts, log: JobLog): Promise<ThumbOutcome | null> {
    const started = await this.database.uow.run((tx) => this.repository.startCall(tx, job.id));
    if (!started) return null;
    const began = Date.now();
    facts.key = key;
    const result = await this.keys.with<GeneratedImage | Refusal>(key, log, async (credential) => {
      facts.usage = 'unconfirmed';
      try {
        const image = await this.images.generate(credential, { prompt: thumbPrompt(job.calloutText) });
        facts.usage = 'succeeded';
        facts.keyOk = true;
        return image;
      } catch (error) {
        return this.refusal(error, facts);
      } finally {
        facts.latencyMs = Date.now() - began;
      }
    });
    if (result === 'unreadable') {
      facts.key = null;
      return this.settleFailure(job, { cause: 'configuration', message: MESSAGES.keyUnreadable, errorCode: 'key_unreadable' }, facts);
    }
    if ('cause' in result) return this.settleFailure(job, result, facts);
    return this.store(job, result, facts, log);
  }

  /** A failed call is a failed job with the cause (ARCHITECTURE §5.10) and a usage effect from the §5.10 table. */
  private refusal(error: unknown, facts: CallFacts): Refusal {
    if (error instanceof ProviderInvalidResponse) {
      facts.usage = 'succeeded';
      return { cause: 'output_unreachable', message: MESSAGES.invalid, errorCode: 'invalid_response' };
    }
    if (!(error instanceof ProviderCallFailed)) {
      facts.usage = 'unconfirmed';
      return { cause: 'outcome_unknown', message: MESSAGES.unknown, errorCode: 'thumbstopper_error' };
    }
    const c = error.classification;
    facts.usage = c.usageEvent === 'none' ? 'none' : c.usageEvent === 'rejected_zero' ? 'rejected' : 'unconfirmed';
    if (c.countsAsAuthFailure) facts.keyOk = false;
    switch (c.causeClass) {
      case 'credit':
        return { cause: 'credit', message: MESSAGES.credit, errorCode: 'credit' };
      case 'configuration':
        return { cause: 'configuration', message: MESSAGES.configuration, errorCode: 'configuration' };
      case 'provider_timeout':
        return { cause: 'provider_timeout', message: MESSAGES.timeout, errorCode: 'provider_timeout' };
      case 'outcome_unknown':
        return { cause: 'outcome_unknown', message: MESSAGES.unknown, errorCode: 'outcome_unknown' };
      default:
        return { cause: 'temporary', message: MESSAGES.temporary, errorCode: c.causeClass };
    }
  }

  /** The image goes under the campaign's prefix, then the job completes with its registered row. The bytes are private: only a signed URL reads them. */
  private async store(job: ThumbJobContext, image: GeneratedImage, facts: CallFacts, log: JobLog): Promise<ThumbOutcome> {
    const mediaId = job.id;
    const storageKey = campaignKey(job.ownerId, job.campaignId, 'thumbstopper', mediaId, image.extension);
    try {
      await this.put(storageKey, image);
    } catch {
      log.warn({ module: 'production', outcome: 'error', jobId: job.id }, 'thumbstopper image could not be stored');
      return this.settleFailure(job, { cause: 'output_unreachable', message: MESSAGES.unsaved, errorCode: 'store_failed' }, facts);
    }
    const completed = await this.database.uow.run(async (tx) => {
      const done = await this.repository.complete(tx, job, mediaId, (inner) =>
        this.media.registerImage(inner, { id: mediaId, ownerId: job.ownerId, campaignId: job.campaignId, storageKey, bytes: image.bytes.length, contentType: image.contentType }),
      );
      // Written whether or not the job was still ours: the call was made, so its cost is counted (idempotent per call).
      await this.settleUsage(tx, job, facts);
      return done;
    });
    if (!completed) {
      await this.discard(storageKey, job.id, log);
      return 'ignored';
    }
    return 'completed';
  }

  private async put(storageKey: string, image: GeneratedImage): Promise<void> {
    try {
      await this.storage.put(storageKey, Readable.from(image.bytes), image.contentType, this.config.outputMaxBytes);
    } catch (error) {
      // An object already there from an earlier attempt of this same job is the image.
      if ((error as { name?: string }).name !== 'StorageKeyExists') throw error;
    }
  }

  private async discard(storageKey: string, jobId: string, log: JobLog): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch {
      // The campaign deletion run removes whatever is left under the campaign's prefix.
      log.warn({ module: 'production', outcome: 'error', jobId }, 'discarded thumbstopper image could not be deleted');
    }
  }

  private async settleFailure(job: ThumbJobContext, refusal: Refusal, facts: CallFacts): Promise<ThumbOutcome> {
    return this.database.uow.run(async (tx) => {
      const moved = await this.repository.fail(tx, job.id, refusal.cause, refusal.message, refusal.errorCode);
      await this.settleUsage(tx, job, facts);
      return moved ? 'failed' : 'ignored';
    });
  }

  /** Writes the call's usage event and drops the reservation. */
  private async settleUsage(tx: DbTx, job: ThumbJobContext, facts: CallFacts): Promise<void> {
    const call: BillableCall = { provider: 'openai', operation: job.providerModel };
    const base = { ownerId: job.ownerId, call, jobType: 'thumbstopper' as const, jobId: job.id, callSeq: 1 };
    if (facts.usage === 'succeeded') await this.usage.record(tx, { ...base, outcome: 'succeeded', latencyMs: facts.latencyMs });
    else if (facts.usage === 'rejected') await this.usage.record(tx, { ...base, outcome: 'rejected', latencyMs: facts.latencyMs });
    else if (facts.usage === 'unconfirmed') await this.usage.convertUnconfirmed(tx, base);
    await this.usage.release(tx, { ownerId: job.ownerId, jobType: 'thumbstopper', jobId: job.id });
  }
}
