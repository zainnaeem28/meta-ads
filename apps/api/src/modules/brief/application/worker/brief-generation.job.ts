import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database, DbTx } from '../../../../platform/db/index.js';
import { DomainError } from '../../../../platform/http/domain-error.js';
import { newId } from '../../../../platform/shared-kernel/index.js';
import { UsageService } from '../../../usage/index.js';
import type { BillableCall } from '../../../usage/index.js';
import {
  WORD_COUNT_TRIMMED_MESSAGE,
  WORD_COUNT_TRIMMED_RULE_ID,
  checkBrief,
} from '../../domain/claim-check.js';
import type { CompiledRules } from '../../domain/claim-check.js';
import { reconcileIssues } from '../../domain/issues.js';
import type { SegmentFinding } from '../../domain/issues.js';
import { HARD_MAX_WORDS, countWords } from '../../domain/words.js';
import { gateKey } from './key-gate.js';
import { ProviderCallRunner } from './provider-call.js';
import { finalizeSegment, tooLong, trimOverLong } from './post-process.js';
import { BRIEF_JOB_REPOSITORY, BRIEF_WORKER_CONFIG, CLAIM_RULES } from './ports.js';
import type {
  BriefContext,
  BriefJobRepository,
  BriefJobRow,
  BriefWorkerConfig,
  ClaimRules,
  JobCause,
  JobLog,
  NewIssue,
  WrittenSegment,
} from './ports.js';
import { TEXT_AI_PORT } from './text-ai.port.js';
import type { DraftSegment, TextAIPort } from './text-ai.port.js';

export const BRIEF_GENERATE_QUEUE = 'brief.generate';
const DIALOGUE_COLUMN = 600;
const PROMPT_COLUMN = 2000;

export type BriefGenerationOutcome = 'completed' | 'failed' | 'skipped';

/** Why a gate or a step refused; the job is failed with it and the owner can try again. */
interface Refusal {
  readonly cause: JobCause;
  readonly message: string;
}

const UNUSABLE: Refusal = {
  cause: 'temporary',
  message: 'The provider returned an answer that could not be used. Try again.',
};

/**
 * `brief.generate` (ARCHITECTURE §5.3, §5.5): the cap check and the claim guards first, then at most two OpenAI calls.
 * Call 1 writes the brief; call 2 (`shortenSegments`) runs only when a segment is over 45 words. Then the deterministic
 * clean-up, the claim rules, and the segments are written in place (SB-D11) in one transaction. A failure leaves the
 * owner able to continue: the brief is `failed` (first generation) or back to `draft` with its old text.
 */
@Injectable()
export class BriefGenerationJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(BRIEF_JOB_REPOSITORY) private readonly repository: BriefJobRepository,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(ProviderCallRunner) private readonly calls: ProviderCallRunner,
    @Inject(TEXT_AI_PORT) private readonly ai: TextAIPort,
    @Inject(CLAIM_RULES) private readonly rules: ClaimRules,
    @Inject(BRIEF_WORKER_CONFIG) private readonly config: Pick<BriefWorkerConfig, 'textModel'>,
  ) {}

  /** The queue handler: the job ID is the whole payload. */
  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<BriefGenerationOutcome> {
    const jobId = (job.data as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string') throw new TypeError('brief.generate job has no jobId');
    const outcome = await this.run(jobId, log);
    log.info(
      { module: 'brief', outcome: outcome === 'failed' ? 'error' : 'ok', jobId },
      `brief generation: ${outcome}`,
    );
    return outcome;
  }

  async run(jobId: string, log: JobLog): Promise<BriefGenerationOutcome> {
    const textCall: BillableCall = { provider: 'openai', operation: this.config.textModel };
    let rules: CompiledRules;
    try {
      rules = await this.rules.activeRules();
    } catch {
      return this.failBeforeClaim(
        jobId,
        { cause: 'temporary', message: 'The brief rules are not available. Try again shortly.' },
        log,
      );
    }

    const gate = await this.database.uow.run(async (tx) => {
      const job = await this.repository.findJob(tx, jobId);
      if (
        job === null ||
        job.state !== 'pending' ||
        job.kind !== 'brief_generation' ||
        job.campaignId === null
      ) {
        return { kind: 'skipped' as const };
      }
      const context = await this.repository.findContext(tx, job.campaignId);
      if (context === null)
        return this.refuse(tx, job, {
          cause: 'cancelled_campaign_deleted',
          message: 'The campaign no longer exists.',
        });
      const keyGate = gateKey(
        job,
        job.keyId === null ? null : await this.repository.findKey(tx, job.keyId),
      );
      if (!keyGate.ok) return this.refuse(tx, job, keyGate, context);
      // The cap check (REQ-019) is the reservation: it exists already when the api created the job, and is made here
      // under the owner's spend lock when it does not. No provider is called before it passes.
      try {
        await this.usage.reserve(tx, {
          ownerId: job.ownerId,
          jobType: 'brief_generation',
          jobId,
          calls: [textCall, textCall],
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return this.refuse(tx, job, { cause: 'temporary', message: error.message }, context);
      }
      return { kind: 'go' as const, job, context, key: keyGate.key };
    });
    if (gate.kind === 'skipped') return 'skipped';
    if (gate.kind === 'refused') return 'failed';

    const claimed = await this.database.uow.run((tx) => this.repository.claim(tx, jobId));
    if (!claimed) return 'skipped';

    const { job, context, key } = gate;
    const lastPosition = context.input.segmentCount;
    const first = await this.calls.run(
      { job, key, jobType: 'brief_generation', call: textCall, seq: 1 },
      log,
      (credential) => this.ai.generateBrief(credential, context.input),
    );
    if (!first.ok) return this.failAfterClaim(job, first, log);

    let segments = first.value.segments.map((segment) =>
      finalizeSegment(segment, segment.position === lastPosition),
    );
    const over = segments.filter(tooLong);
    if (over.length > 0) {
      const second = await this.calls.run(
        { job, key, jobType: 'brief_generation', call: textCall, seq: 2 },
        log,
        (credential) => this.ai.shortenSegments(credential, over, HARD_MAX_WORDS),
      );
      // The second call failing does not lose the first: its text is trimmed below and the owner reads it again.
      if (second.ok) {
        const shortened = new Map(second.value.map((segment) => [segment.position, segment]));
        segments = segments.map((segment) => {
          const next = shortened.get(segment.position);
          return next === undefined
            ? segment
            : finalizeSegment(
                { ...segment, dialogue: next.dialogue },
                segment.position === lastPosition,
              );
        });
      }
    }
    const trim = trimOverLong(segments, lastPosition);
    segments = trim.segments;
    if (
      segments.some((s) => s.dialogue.length > DIALOGUE_COLUMN || s.prompt.length > PROMPT_COLUMN)
    ) {
      return this.failAfterClaim(job, { ...UNUSABLE, code: 'too_long' }, log);
    }

    const write = this.plan(context, segments, trim.trimmed, rules);
    const settled = await this.database.uow.run(async (tx) => {
      const result = await this.repository.completeGeneration(tx, job, context, write);
      await this.usage.release(tx, { ownerId: job.ownerId, jobType: 'brief_generation', jobId });
      return result;
    });
    log.info(
      { module: 'brief', outcome: 'ok', jobId, written: settled.kind === 'written' },
      'brief generation written',
    );
    return 'completed';
  }

  /** The segments to write and the issues to close and raise (REQ-007, REQ-008). */
  private plan(
    context: BriefContext,
    segments: readonly DraftSegment[],
    trimmed: readonly number[],
    rules: CompiledRules,
  ): { segments: WrittenSegment[]; close: string[]; raise: NewIssue[] } {
    const idOf = new Map(context.segments.map((segment) => [segment.position, segment.id]));
    const before = new Map(context.segments.map((segment) => [segment.position, segment]));
    const written: WrittenSegment[] = segments.map((segment) => ({
      id: idOf.get(segment.position) ?? newId(),
      position: segment.position,
      dialogue: segment.dialogue,
      prompt: segment.prompt,
      wordCount: Math.min(countWords(segment.dialogue), 120),
    }));
    const segmentId = new Map(written.map((segment) => [segment.position, segment.id]));
    const findings: SegmentFinding[] = checkBrief(rules, segments).map(
      ({ position, ...finding }) => ({
        ...finding,
        segmentId: segmentId.get(position) ?? '',
      }),
    );
    for (const position of trimmed) {
      findings.push({
        ruleId: WORD_COUNT_TRIMMED_RULE_ID,
        class: 'other',
        field: 'dialogue',
        message: WORD_COUNT_TRIMMED_MESSAGE,
        spanStart: null,
        spanEnd: null,
        segmentId: segmentId.get(position) ?? '',
      });
    }
    const changed = new Set(
      written
        .filter((segment) => {
          const old = before.get(segment.position);
          return (
            old === undefined || old.dialogue !== segment.dialogue || old.prompt !== segment.prompt
          );
        })
        .map((segment) => segment.id),
    );
    const { close, raise } = reconcileIssues(
      context.issues,
      findings,
      new Set(written.map((segment) => segment.id)),
      changed,
    );
    return {
      segments: written,
      close: [...close],
      raise: raise.map((finding) => ({
        segmentId: finding.segmentId,
        field: finding.field,
        ruleId: finding.ruleId,
        class: finding.class,
        message: finding.message,
        spanStart: finding.spanStart,
        spanEnd: finding.spanEnd,
      })),
    };
  }

  /** A refusal at the gate: the job is failed from `pending`, the reservation is dropped and the brief is settled. */
  private async refuse(
    tx: DbTx,
    job: BriefJobRow,
    refusal: Refusal,
    context?: BriefContext,
  ): Promise<{ kind: 'refused' }> {
    await this.repository.failPending(tx, job.id, refusal.cause, refusal.message);
    await this.usage.release(tx, {
      ownerId: job.ownerId,
      jobType: 'brief_generation',
      jobId: job.id,
    });
    if (job.campaignId !== null && context !== undefined) {
      await this.repository.settleBriefAfterFailure(tx, job.campaignId, job.generationSeq);
    }
    return { kind: 'refused' };
  }

  private async failBeforeClaim(
    jobId: string,
    refusal: Refusal,
    log: JobLog,
  ): Promise<BriefGenerationOutcome> {
    const failed = await this.database.uow.run(async (tx) => {
      const job = await this.repository.findJob(tx, jobId);
      if (job === null || job.state !== 'pending') return false;
      const context =
        job.campaignId === null
          ? undefined
          : ((await this.repository.findContext(tx, job.campaignId)) ?? undefined);
      await this.refuse(tx, job, refusal, context);
      return true;
    });
    if (failed)
      log.warn(
        { module: 'brief', outcome: 'error', jobId },
        'brief generation refused before any call',
      );
    return failed ? 'failed' : 'skipped';
  }

  /** After the claim: the job is failed from `submitting`; usage events already carry what was billed. */
  private async failAfterClaim(
    job: BriefJobRow,
    failure: { cause: JobCause; message: string; code: string },
    log: JobLog,
  ): Promise<BriefGenerationOutcome> {
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
        jobType: 'brief_generation',
        jobId: job.id,
      });
      if (job.campaignId !== null)
        await this.repository.settleBriefAfterFailure(tx, job.campaignId, job.generationSeq);
    });
    log.warn(
      { module: 'brief', outcome: 'error', jobId: job.id, cause: failure.cause },
      'brief generation failed',
    );
    return 'failed';
  }
}
