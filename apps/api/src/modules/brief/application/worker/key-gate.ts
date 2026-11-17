import type { BriefJobRow, JobCause, SealedKeyRow } from './ports.js';

export type KeyGate =
  | { readonly ok: true; readonly key: SealedKeyRow }
  | { readonly ok: false; readonly cause: JobCause; readonly message: string };

/**
 * The claim guard on the key (ARCHITECTURE §5.5): the row the job was created with must still exist, belong to the
 * owner, be the same version and not be disabled. Any other state means no call and no charge.
 */
export function gateKey(job: BriefJobRow, key: SealedKeyRow | null): KeyGate {
  if (job.keyId === null || key === null || key.ownerId !== job.ownerId) {
    return {
      ok: false,
      cause: 'key_deleted',
      message: 'The OpenAI key this job used was removed. Add a key and try again.',
    };
  }
  if (key.provider !== 'openai') {
    return {
      ok: false,
      cause: 'configuration',
      message: 'The key this job used is not an OpenAI key.',
    };
  }
  if (job.keyVersion === null || key.version !== job.keyVersion) {
    return {
      ok: false,
      cause: 'key_replaced',
      message: 'Your OpenAI key was replaced while this job waited. Try again.',
    };
  }
  if (key.status === 'disabled') {
    return {
      ok: false,
      cause: 'configuration',
      message: 'Your OpenAI key is disabled. Enter it again.',
    };
  }
  return { ok: true, key };
}
