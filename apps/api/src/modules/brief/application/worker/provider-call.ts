import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database } from '../../../../platform/db/index.js';
import { UsageService } from '../../../usage/index.js';
import type { BillableCall, JobType } from '../../../usage/index.js';
import { BRIEF_JOB_REPOSITORY, KEY_AUTH_REPORTER, KEY_OPENER } from './ports.js';
import type { BriefJobRepository, BriefJobRow, JobCause, JobLog, KeyAuthReporter, KeyOpener, SealedKeyRow } from './ports.js';
import { ProviderCallFailed, ProviderInvalidResponse } from './text-ai.port.js';
import type { ProviderCredential } from './text-ai.port.js';

export type CallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly cause: JobCause; readonly message: string; readonly code: string };

export interface CallPlan {
  readonly job: BriefJobRow;
  readonly key: SealedKeyRow;
  readonly jobType: JobType;
  readonly call: BillableCall;
  /** 1 for the first call of the job, 2 for the second. */
  readonly seq: number;
}

const UNREADABLE = 'The provider returned an answer that could not be used. Try again.';

/**
 * One paid provider call of a job, at most once (ARCHITECTURE §5.5): the call is counted on the job before the key is
 * opened, the key is opened only here (by key ID, in the worker) and zeroed after the call, and the answer settles
 * the usage event and the key's auth count in their own transactions. No transaction is open during the call.
 */
@Injectable()
export class ProviderCallRunner {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(BRIEF_JOB_REPOSITORY) private readonly repository: BriefJobRepository,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(KEY_OPENER) private readonly opener: KeyOpener,
    @Inject(KEY_AUTH_REPORTER) private readonly auth: KeyAuthReporter,
  ) {}

  async run<T>(plan: CallPlan, log: JobLog, fn: (credential: ProviderCredential) => Promise<T>): Promise<CallResult<T>> {
    const { job, key, jobType, call, seq } = plan;
    const started = await this.database.uow.run((tx) => this.repository.startCall(tx, job.id, seq));
    if (!started) return { ok: false, cause: 'outcome_unknown', message: 'The job was already settled.', code: 'not_submitting' };
    let apiKey: Buffer;
    try {
      apiKey = this.opener.unseal(key.sealed, { userId: key.ownerId, provider: key.provider, keyId: key.id, version: key.version });
    } catch {
      // Nothing was sent: no usage event; the caller releases the reservation.
      log.warn({ module: 'brief', outcome: 'error', jobId: job.id }, 'provider key could not be opened');
      return { ok: false, cause: 'configuration', message: 'Your OpenAI key could not be read. Enter it again.', code: 'key_unreadable' };
    }
    const base = { ownerId: job.ownerId, call, jobType, jobId: job.id, callSeq: seq };
    const began = Date.now();
    try {
      const value = await fn({ apiKey });
      const latencyMs = Date.now() - began;
      await this.database.uow.run((tx) => this.usage.record(tx, { ...base, outcome: 'succeeded', latencyMs }));
      await this.reportAuth(key, true, log);
      return { ok: true, value };
    } catch (error) {
      return await this.settleFailure(error, base, key, Date.now() - began, log);
    } finally {
      apiKey.fill(0);
    }
  }

  private async settleFailure(
    error: unknown,
    base: { ownerId: string; call: BillableCall; jobType: JobType; jobId: string; callSeq: number },
    key: SealedKeyRow,
    latencyMs: number,
    log: JobLog,
  ): Promise<CallResult<never>> {
    if (error instanceof ProviderInvalidResponse) {
      // The call was made and answered, so it is billed; the answer is not usable.
      await this.database.uow.run((tx) => this.usage.record(tx, { ...base, outcome: 'failed', latencyMs }));
      log.warn({ module: 'brief', outcome: 'error', jobId: base.jobId }, 'provider answer did not match the schema');
      return { ok: false, cause: 'temporary', message: UNREADABLE, code: 'invalid_response' };
    }
    if (error instanceof ProviderCallFailed) {
      const c = error.classification;
      if (c.usageEvent === 'rejected_zero') {
        await this.database.uow.run((tx) => this.usage.record(tx, { ...base, outcome: 'rejected', latencyMs }));
      } else if (c.usageEvent === 'unconfirmed') {
        await this.database.uow.run((tx) => this.usage.convertUnconfirmed(tx, base));
      }
      if (c.countsAsAuthFailure) await this.reportAuth(key, false, log);
      const cause: JobCause = c.causeClass === 'configuration' || c.causeClass === 'credit' || c.causeClass === 'outcome_unknown' ? c.causeClass : 'temporary';
      return { ok: false, cause, message: c.message ?? 'The provider call failed. Try again.', code: c.causeClass };
    }
    // Anything else after the key was opened: whether the provider saw the request is unknown, so the estimate stays counted.
    await this.database.uow.run((tx) => this.usage.convertUnconfirmed(tx, base));
    log.warn({ module: 'brief', outcome: 'error', jobId: base.jobId }, 'provider call ended unexpectedly');
    return { ok: false, cause: 'outcome_unknown', message: 'Check your provider account before retrying.', code: 'unexpected' };
  }

  private async reportAuth(key: SealedKeyRow, ok: boolean, log: JobLog): Promise<void> {
    try {
      await this.auth.report(key.id, key.version, ok);
    } catch {
      log.warn({ module: 'brief', outcome: 'error', keyId: key.id }, 'key auth result could not be recorded');
    }
  }
}
