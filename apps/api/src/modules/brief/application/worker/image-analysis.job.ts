import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database, DbTx } from '../../../../platform/db/index.js';
import { DomainError } from '../../../../platform/http/domain-error.js';
import { UsageService } from '../../../usage/index.js';
import type { BillableCall } from '../../../usage/index.js';
import { gateKey } from './key-gate.js';
import { ProviderCallRunner } from './provider-call.js';
import { dropSensitiveSentences } from './post-process.js';
import { BRIEF_JOB_REPOSITORY, BRIEF_WORKER_CONFIG, IMAGE_SOURCE } from './ports.js';
import type {
  BriefJobRepository,
  BriefJobRow,
  BriefWorkerConfig,
  ImageSource,
  JobCause,
  JobLog,
} from './ports.js';
import { TEXT_AI_PORT } from './text-ai.port.js';
import type { TextAIPort } from './text-ai.port.js';

export const BRIEF_ANALYZE_IMAGE_QUEUE = 'brief.analyze-image';

export type ImageAnalysisOutcome = 'completed' | 'failed' | 'skipped';

interface Refusal {
  readonly cause: JobCause;
  readonly message: string;
}

const IMAGE_UNAVAILABLE: Refusal = {
  cause: 'temporary',
  message: 'The product image is not available. Continue without a description.',
};

/**
 * `brief.analyze-image` (ARCHITECTURE §5.4, REQ-006, REQ-020): the sanitized product image is read from storage and its
 * bytes are sent inline to OpenAI. The answer is `{productDescription}` only; sentences that mention ethnicity, race,
 * age, health, body or medical terms are dropped by the word list of `config/brand-rules.json`. A failure of any kind
 * ends the job `failed` and the owner continues without a description.
 */
@Injectable()
export class ImageAnalysisJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(BRIEF_JOB_REPOSITORY) private readonly repository: BriefJobRepository,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(ProviderCallRunner) private readonly calls: ProviderCallRunner,
    @Inject(TEXT_AI_PORT) private readonly ai: TextAIPort,
    @Inject(IMAGE_SOURCE) private readonly images: ImageSource,
    @Inject(BRIEF_WORKER_CONFIG)
    private readonly config: Pick<BriefWorkerConfig, 'visionModel' | 'sensitiveTerms'>,
  ) {}

  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<ImageAnalysisOutcome> {
    const jobId = (job.data as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string') throw new TypeError('brief.analyze-image job has no jobId');
    const outcome = await this.run(jobId, log);
    log.info(
      { module: 'brief', outcome: outcome === 'failed' ? 'error' : 'ok', jobId },
      `image analysis: ${outcome}`,
    );
    return outcome;
  }

  async run(jobId: string, log: JobLog): Promise<ImageAnalysisOutcome> {
    const visionCall: BillableCall = { provider: 'openai', operation: this.config.visionModel };
    const gate = await this.database.uow.run(async (tx) => {
      const job = await this.repository.findJob(tx, jobId);
      if (
        job === null ||
        job.state !== 'pending' ||
        job.kind !== 'image_analysis' ||
        job.mediaId === null
      ) {
        return { kind: 'skipped' as const };
      }
      const media = await this.repository.findMedia(tx, job.mediaId);
      if (
        media === null ||
        media.ownerId !== job.ownerId ||
        media.state !== 'ready' ||
        media.contentType === null
      ) {
        return this.refuse(tx, job, IMAGE_UNAVAILABLE);
      }
      const keyGate = gateKey(
        job,
        job.keyId === null ? null : await this.repository.findKey(tx, job.keyId),
      );
      if (!keyGate.ok) return this.refuse(tx, job, keyGate);
      // The cap check precedes any call: the reservation exists when the api created the job, else it is made here.
      try {
        await this.usage.reserve(tx, {
          ownerId: job.ownerId,
          jobType: 'image_analysis',
          jobId,
          calls: [visionCall],
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return this.refuse(tx, job, { cause: 'temporary', message: error.message });
      }
      return { kind: 'go' as const, job, media, key: keyGate.key };
    });
    if (gate.kind === 'skipped') return 'skipped';
    if (gate.kind === 'refused') return 'failed';
    const { job, media, key } = gate;

    let bytes: Buffer;
    try {
      bytes = await this.images.read(media.storageKey);
    } catch {
      await this.refuseOutside(job, IMAGE_UNAVAILABLE);
      log.warn({ module: 'brief', outcome: 'error', jobId }, 'product image could not be read');
      return 'failed';
    }

    const claimed = await this.database.uow.run((tx) => this.repository.claim(tx, jobId));
    if (!claimed) return 'skipped';

    const contentType = media.contentType as string;
    const called = await this.calls.run(
      { job, key, jobType: 'image_analysis', call: visionCall, seq: 1 },
      log,
      (credential) => this.ai.describeProduct(credential, bytes, contentType),
    );
    if (!called.ok) return this.failAfterClaim(job, called, log);

    const description = dropSensitiveSentences(called.value, this.config.sensitiveTerms);
    if (description === '') {
      return this.failAfterClaim(
        job,
        {
          cause: 'temporary',
          message: 'No usable description came back. Continue without one.',
          code: 'empty_description',
        },
        log,
      );
    }
    await this.database.uow.run(async (tx) => {
      await this.repository.completeAnalysis(tx, jobId, description);
      await this.usage.release(tx, { ownerId: job.ownerId, jobType: 'image_analysis', jobId });
    });
    return 'completed';
  }

  private async refuse(tx: DbTx, job: BriefJobRow, refusal: Refusal): Promise<{ kind: 'refused' }> {
    await this.repository.failPending(tx, job.id, refusal.cause, refusal.message);
    await this.usage.release(tx, {
      ownerId: job.ownerId,
      jobType: 'image_analysis',
      jobId: job.id,
    });
    return { kind: 'refused' };
  }

  private async refuseOutside(job: BriefJobRow, refusal: Refusal): Promise<void> {
    await this.database.uow.run((tx) => this.refuse(tx, job, refusal));
  }

  private async failAfterClaim(
    job: BriefJobRow,
    failure: { cause: JobCause; message: string; code: string },
    log: JobLog,
  ): Promise<ImageAnalysisOutcome> {
    await this.database.uow.run(async (tx) => {
      await this.repository.failSubmitting(
        tx,
        job.id,
        failure.cause,
        failure.message,
        failure.code,
      );
      await this.usage.release(tx, {
        ownerId: job.ownerId,
        jobType: 'image_analysis',
        jobId: job.id,
      });
    });
    log.warn(
      { module: 'brief', outcome: 'error', jobId: job.id, cause: failure.cause },
      'image analysis failed',
    );
    return 'failed';
  }
}
