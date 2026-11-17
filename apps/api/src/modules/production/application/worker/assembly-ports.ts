import type { DbTx } from '../../../../platform/db/index.js';

// The worker side of the assembly (TASK-056, ARCHITECTURE §1.3 AssemblyPort, §5.7): what the render handler needs of the
// renderer and of media registration, as interfaces. The FFmpeg adapter lives in `infrastructure/ffmpeg/`; Shotstack is not
// built (owner decision OD-08: FFmpeg by default, the vendor adapter descoped by recorded ruling).

/** `assembly_jobs.cause_class` values a render can end with (the cancel classes belong to the deletion and suspension runs). */
export type AssemblyCause = 'render_failed' | 'input_unavailable' | 'timeout';

/** A render that cannot succeed by trying again; `causeClass` is what the user sees as the cause. */
export class AssemblyRenderError extends Error {
  constructor(
    readonly causeClass: AssemblyCause,
    detail: string,
  ) {
    super(`assembly render failed (${causeClass}): ${detail}`);
    this.name = 'AssemblyRenderError';
  }
}

export interface AssemblyRenderInput {
  /** The clips as local files, in the order they are joined. */
  readonly clips: readonly string[];
  /** The still shown first (the thumbstopper), or null for none. */
  readonly openingFrame: string | null;
  /** The file to write: inside the caller's own temporary directory. */
  readonly output: string;
  /** Ends the render when aborted (the lease was lost, the process is stopping). */
  readonly signal?: AbortSignal;
}

export interface AssemblyProgress {
  /** 0 to 1 of the final video's length. */
  readonly fraction: number;
}

/** AssemblyPort: joins local clip files into one MP4 on the local disk only. It never reads storage or the database. */
export interface AssemblyPort {
  render(input: AssemblyRenderInput, onProgress: (progress: AssemblyProgress) => void): Promise<{ readonly bytes: number }>;
}
export const ASSEMBLY_PORT = Symbol('ASSEMBLY_PORT');

export interface AssemblyWorkerConfig {
  /** How long a claim holds the job; progress and each phase renew it. An expired lease lets another run resume. */
  readonly leaseSec: number;
  /** Claims a job may take before it ends `render_failed` (a crash loop does not render forever). */
  readonly maxAttempts: number;
  /** Renders at once in this process (`ASSEMBLY_CONCURRENCY`). */
  readonly concurrency: number;
  /** Seconds the opening frame is shown (`THUMBSTOPPER_FRAME_SECONDS`). */
  readonly frameSeconds: number;
  /** Largest final video the worker stores. */
  readonly outputMaxBytes: number;
  /** A job still `pending` or `queued` this long has lost its queue message. */
  readonly requeueAfterSec: number;
}
export const ASSEMBLY_WORKER_CONFIG = Symbol('ASSEMBLY_WORKER_CONFIG');

/** What the render handler needs of the media module: records the stored final video in the caller's transaction. */
export interface AssemblyMedia {
  registerFinal(
    tx: DbTx,
    input: { readonly id: string; readonly ownerId: string; readonly campaignId: string; readonly storageKey: string; readonly bytes: number },
  ): Promise<void>;
}
export const ASSEMBLY_MEDIA = Symbol('ASSEMBLY_MEDIA');
