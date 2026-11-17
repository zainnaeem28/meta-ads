import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { claimWithUserLimit, jobTable } from '../../../platform/jobs/claim.js';
import { UsageService } from '../../usage/index.js';
import type { BillableCall } from '../../usage/index.js';
import type { StoragePort } from '../../media/index.js';
import { QcKeySession, gateQcKey } from './qc-key-session.js';
import { AUDIO_EXTRACTOR, QC_CONFIG, QC_REPOSITORY, TRANSCRIBE_PORT } from './qc-ports.js';
import type {
  AudioExtractor,
  QcConfig,
  QcRepository,
  QcRunContext,
  QcSettlement,
  TranscribePort,
} from './qc-ports.js';
import { judge } from './qc-wer.js';
import { PRODUCTION_STORAGE, ProviderCallFailed, ProviderInvalidResponse } from './worker/ports.js';
import type { JobLog, SealedKeyRow } from './worker/ports.js';

export const QC_RUN_QUEUE = 'production.qc-run';
export const QC_TABLE = jobTable('qc_runs');

export type QcRunOutcome = 'passed' | 'failed' | 'skipped' | 'ignored';

const REASONS = {
  unavailable: 'This clip is not available to check.',
  noText: 'This segment has no spoken text to check.',
  outOfDate: 'The segment changed after this clip was made, so its audio was not compared.',
  noAudio: 'No audio track in this clip.',
  unreadable: 'The audio of this clip could not be read. Re-run QC.',
  keyUnreadable: 'Your OpenAI key could not be read. Enter it again in Settings, then re-run QC.',
  invalid: 'The transcription could not be read. Re-run QC.',
  unknown: 'The check could not be completed. Re-run QC.',
  temporary: 'The transcription service was not available. Re-run QC.',
  configuration: 'OpenAI did not accept the request. Check your key in Settings, then re-run QC.',
  credit: 'Your OpenAI account has no credit left. Add credit, then re-run QC.',
} as const;

const skipped = (reason: string, errorCode: string | null = null): QcSettlement => ({
  qcState: 'skipped',
  reason,
  wordErrorRate: null,
  errorCode,
});

/** What the call closure learns, for the usage and key bookkeeping after the run is settled. */
interface CallFacts {
  /** The request left the process: an unbilled refusal is recorded at zero, anything unknown stays counted. */
  usage: 'none' | 'succeeded' | 'rejected' | 'unconfirmed';
  latencyMs: number;
  /** The key the call used, and what it told about it. */
  key: SealedKeyRow | null;
  keyOk: boolean | null;
}

/**
 * `production.qc-run` (ARCHITECTURE §5.6): the claim, then at most one transcription of the clip's audio. `submitting` is
 * committed before the clip is read or the provider called; the answer settles the run and its usage event together. A
 * crash in between leaves `submitting`, which the recovery sweep settles as `skipped`; the call is never repeated. Every
 * outcome is one of passed, failed or skipped with its reason (QC never blocks assembly). The key and cap checks were made
 * when the run was created; the key is checked again here before the paid call. The transcript is compared and dropped:
 * it is never logged and never stored whole.
 */
@Injectable()
export class QcRunJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(QC_REPOSITORY) private readonly repository: QcRepository,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(QcKeySession) private readonly keys: QcKeySession,
    @Inject(TRANSCRIBE_PORT) private readonly transcriber: TranscribePort,
    @Inject(AUDIO_EXTRACTOR) private readonly audio: AudioExtractor,
    @Inject(PRODUCTION_STORAGE) private readonly storage: Pick<StoragePort, 'get'>,
    @Inject(QC_CONFIG) private readonly config: QcConfig,
  ) {}

  /** The queue handler: the run ID is the whole payload. */
  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<QcRunOutcome> {
    const runId = (job.data as { runId?: unknown } | null)?.runId;
    if (typeof runId !== 'string') throw new TypeError('production.qc-run job has no runId');
    const outcome = await this.run(runId, log);
    log.info({ module: 'production', outcome: 'ok', runId }, `qc run: ${outcome}`);
    return outcome;
  }

  async run(runId: string, log: JobLog): Promise<QcRunOutcome> {
    const run = await this.database.uow.run((tx) => this.repository.findRun(tx, runId));
    if (run === null || run.state !== 'pending') return 'ignored';
    const claim = await this.database.uow.run((tx) =>
      claimWithUserLimit(tx, QC_TABLE, runId, { limit: null }),
    );
    if (claim.kind !== 'claimed') return 'ignored';

    const facts: CallFacts = { usage: 'none', latencyMs: 0, key: null, keyOk: null };
    let settlement: QcSettlement | null;
    try {
      settlement = await this.evaluate(run, facts, log);
    } catch {
      // Whatever went wrong is not the user's to fix; a call that may have gone out keeps its estimate counted.
      settlement = skipped(REASONS.unknown, 'qc_error');
      if (facts.usage === 'none' && facts.key !== null && facts.keyOk === null)
        facts.usage = 'unconfirmed';
    }
    if (settlement === null) return 'ignored';
    await this.finish(run, settlement, facts);
    if (facts.key !== null && facts.keyOk !== null)
      await this.keys.report(facts.key, facts.keyOk, log);
    return settlement.qcState;
  }

  /** Reads, checks and (at most once) calls. `null` when the run left `submitting` under it (cancelled, swept). */
  private async evaluate(
    run: QcRunContext,
    facts: CallFacts,
    log: JobLog,
  ): Promise<QcSettlement | null> {
    const plan = await this.plan(run);
    if (plan.kind === 'skip') return plan.settlement;
    const clip = await this.storage.get(plan.storageKey);
    let extracted: Awaited<ReturnType<AudioExtractor['extract']>>;
    try {
      extracted = await this.audio.extract(clip);
    } catch {
      return skipped(REASONS.unreadable, 'audio_unreadable');
    } finally {
      clip.destroy();
    }
    if (extracted.kind === 'none') return skipped(REASONS.noAudio);

    const started = await this.database.uow.run((tx) => this.repository.startCall(tx, run.id));
    if (!started) return null;
    const began = Date.now();
    facts.key = plan.key;
    const result = await this.keys.with<QcSettlement>(plan.key, log, async (credential) => {
      facts.usage = 'unconfirmed';
      try {
        const heard = await this.transcriber.transcribe(credential, extracted.wav, 'en');
        facts.usage = 'succeeded';
        facts.keyOk = true;
        const verdict = judge(plan.dialogue, heard.text, this.config.maxWordErrorRate);
        return {
          qcState: verdict.passed ? 'passed' : 'failed',
          reason: verdict.reason,
          wordErrorRate: verdict.rate,
          errorCode: null,
        };
      } catch (error) {
        return this.refusal(error, facts);
      } finally {
        facts.latencyMs = Date.now() - began;
      }
    });
    if (result === 'unreadable') {
      facts.key = null;
      return skipped(REASONS.keyUnreadable, 'key_unreadable');
    }
    return result;
  }

  /** Everything read before the call: the clip, the dialogue it was made from and the key gate. */
  private async plan(
    run: QcRunContext,
  ): Promise<
    | { kind: 'skip'; settlement: QcSettlement }
    | { kind: 'go'; storageKey: string; dialogue: string; key: SealedKeyRow }
  > {
    if (!run.campaignActive || run.clipState !== 'completed' || run.storageKey === null)
      return { kind: 'skip', settlement: skipped(REASONS.unavailable) };
    if (run.dialogue === null || run.dialogue.trim() === '')
      return { kind: 'skip', settlement: skipped(REASONS.noText) };
    if (run.currentRevision !== run.segmentRevision)
      return { kind: 'skip', settlement: skipped(REASONS.outOfDate) };
    const keys = await this.database.uow.run(async (tx) => ({
      stamped: run.keyId === null ? null : await this.repository.findKey(tx, run.keyId),
      current: run.keyId === null ? await this.repository.findOwnerKey(tx, run.ownerId) : null,
    }));
    const gate = gateQcKey(run, keys.stamped, keys.current);
    if (!gate.ok) return { kind: 'skip', settlement: skipped(gate.reason) };
    return { kind: 'go', storageKey: run.storageKey, dialogue: run.dialogue, key: gate.key };
  }

  /** A failed call is a skipped check with the cause (ARCHITECTURE §5.6) and a usage effect from the §5.10 table. */
  private refusal(error: unknown, facts: CallFacts): QcSettlement {
    if (error instanceof ProviderInvalidResponse) {
      facts.usage = 'succeeded';
      return skipped(REASONS.invalid, 'invalid_response');
    }
    if (!(error instanceof ProviderCallFailed)) {
      facts.usage = 'unconfirmed';
      return skipped(REASONS.unknown, 'qc_error');
    }
    const c = error.classification;
    facts.usage =
      c.usageEvent === 'none'
        ? 'none'
        : c.usageEvent === 'rejected_zero'
          ? 'rejected'
          : 'unconfirmed';
    if (c.countsAsAuthFailure) facts.keyOk = false;
    const reason =
      c.causeClass === 'configuration' || c.causeClass === 'credit'
        ? REASONS[c.causeClass]
        : REASONS.temporary;
    return skipped(reason, c.causeClass);
  }

  /** Settles the run, writes the call's usage event and drops the reservations (the run's own and the clip's QC part). */
  private async finish(
    run: QcRunContext,
    settlement: QcSettlement,
    facts: CallFacts,
  ): Promise<void> {
    const call: BillableCall = { provider: 'openai', operation: this.config.transcribeModel };
    const base = { ownerId: run.ownerId, call, jobType: 'qc' as const, jobId: run.id, callSeq: 1 };
    await this.database.uow.run(async (tx) => {
      await this.repository.settle(tx, run.id, settlement);
      // Written whether or not the run was still ours: the call was made, so its cost is counted (idempotent per call).
      if (facts.usage === 'succeeded')
        await this.usage.record(tx, { ...base, outcome: 'succeeded', latencyMs: facts.latencyMs });
      else if (facts.usage === 'rejected')
        await this.usage.record(tx, { ...base, outcome: 'rejected', latencyMs: facts.latencyMs });
      else if (facts.usage === 'unconfirmed') await this.usage.convertUnconfirmed(tx, base);
      await this.usage.release(tx, { ownerId: run.ownerId, jobType: 'qc', jobId: run.id });
      // The first check of a clip was reserved with the clip (ARCHITECTURE §5.5): that part goes with it.
      await this.usage.release(tx, {
        ownerId: run.ownerId,
        jobType: 'video',
        jobId: run.videoJobId,
      });
    });
  }
}
