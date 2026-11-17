import type { Readable } from 'node:stream';
import type { DbTx } from '../../../platform/db/index.js';
import type { ProviderCredential, SealedKeyRow } from './worker/ports.js';

// The QC run (TASK-054, ARCHITECTURE §5.6): what the check needs of the provider, the clip's audio and persistence, as interfaces.
// The adapters live in `infrastructure/openai-transcribe/`; `production.module.ts` binds them.

/** The spoken words of the clip's audio. The text is compared and dropped: it is never stored whole and never logged. */
export interface Transcript {
  readonly text: string;
}

/**
 * TranscribePort (ARCHITECTURE §1.3): `transcribe` is one paid call, made at most once per QC run (the queue is a submit
 * queue). 60 s timeout; a refusal or failure is `ProviderCallFailed`, an answer that is not a transcript `ProviderInvalidResponse`.
 */
export interface TranscribePort {
  transcribe(credential: ProviderCredential, audio: Buffer, language: 'en'): Promise<Transcript>;
}
export const TRANSCRIBE_PORT = Symbol('TRANSCRIBE_PORT');

/** The clip's audio track as 16 kHz mono WAV, or `none` when the file has no audio track. Throws when the file cannot be read. */
export type ExtractedAudio =
  { readonly kind: 'audio'; readonly wav: Buffer } | { readonly kind: 'none' };

export interface AudioExtractor {
  extract(clip: Readable): Promise<ExtractedAudio>;
}
export const AUDIO_EXTRACTOR = Symbol('AUDIO_EXTRACTOR');

/** Reports what an OpenAI call told about the key (a 401 counts toward disabling it, a success resets the count). */
export const QC_KEY_AUTH_REPORTER = Symbol('QC_KEY_AUTH_REPORTER');

export interface QcConfig {
  /** `OPENAI_TRANSCRIBE_MODEL`. */
  readonly transcribeModel: string;
  /** `QC_MAX_WORD_ERROR_RATE`: at or under it the clip passes. */
  readonly maxWordErrorRate: number;
  /** The provider work of a QC run is bounded at 10 minutes (ARCHITECTURE §5.5). */
  readonly deadlineMinutes: number;
  readonly idempotencyTtlHours: number;
  /** `SUBMIT_ORPHAN_AFTER_SEC`: a run still `submitting` this long after the claim lost its answer. */
  readonly orphanAfterSec: number;
  /** A `pending` run whose queue message was lost is queued again after this long. */
  readonly requeueAfterSec: number;
  /** Test seam: the transcription endpoint, a local stand-in for api.openai.com (the host stays allow-listed). The product never sets it. */
  readonly transcribeUrl?: string;
}
export const QC_CONFIG = Symbol('QC_CONFIG');

/** One QC run with what the check reads of its clip and segment, read in one statement. */
export interface QcRunContext {
  readonly id: string;
  readonly ownerId: string;
  readonly videoJobId: string;
  readonly state: string;
  readonly keyId: string | null;
  readonly keyVersion: number | null;
  readonly callCount: number;
  readonly clipState: string;
  readonly campaignId: string;
  readonly campaignActive: boolean;
  readonly storageKey: string | null;
  readonly segmentRevision: number;
  readonly currentRevision: number | null;
  readonly dialogue: string | null;
}

export interface QcSettlement {
  readonly qcState: 'passed' | 'failed' | 'skipped';
  readonly reason: string | null;
  readonly wordErrorRate: number | null;
  readonly errorCode: string | null;
}

/** What the QC handler and the API read and write of `qc_runs`; every method runs in the caller's transaction. */
export interface QcRepository {
  findRun(tx: DbTx, runId: string): Promise<QcRunContext | null>;
  /** The owner's current OpenAI key, if any. */
  findOwnerKey(tx: DbTx, ownerId: string): Promise<SealedKeyRow | null>;
  findKey(tx: DbTx, keyId: string): Promise<SealedKeyRow | null>;
  /** Counts the one transcription on a `submitting` run. False when a cancel or the sweep already settled it. */
  startCall(tx: DbTx, runId: string): Promise<boolean>;
  /** `submitting` to `completed` with the result. False when the run left `submitting` (cancelled, swept). */
  settle(tx: DbTx, runId: string, settlement: QcSettlement): Promise<boolean>;
}
export const QC_REPOSITORY = Symbol('QC_REPOSITORY');
