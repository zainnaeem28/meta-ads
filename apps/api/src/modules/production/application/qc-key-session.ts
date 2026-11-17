import { Inject, Injectable } from '@nestjs/common';
import { QC_KEY_AUTH_REPORTER } from './qc-ports.js';
import type { QcRunContext } from './qc-ports.js';
import { KEY_OPENER } from './worker/ports.js';
import type {
  JobLog,
  KeyAuthReporter,
  KeyOpener,
  ProviderCredential,
  SealedKeyRow,
} from './worker/ports.js';

export type QcKeyGate =
  | { readonly ok: true; readonly key: SealedKeyRow }
  | { readonly ok: false; readonly reason: string };

export const NO_KEY_REASON = 'Add your OpenAI key in Settings, then re-run QC.';

/**
 * The key check before the paid call (ARCHITECTURE §5.6): the run's own key when it was stamped at creation (same owner,
 * same version, not disabled), else the owner's current OpenAI key. Anything else means no call and no charge, and the
 * check is `skipped` with the reason to show.
 */
export function gateQcKey(
  run: Pick<QcRunContext, 'ownerId' | 'keyId' | 'keyVersion'>,
  stamped: SealedKeyRow | null,
  current: SealedKeyRow | null,
): QcKeyGate {
  const key = run.keyId === null ? current : stamped;
  if (key === null || key.ownerId !== run.ownerId || key.provider !== 'openai')
    return { ok: false, reason: NO_KEY_REASON };
  if (run.keyId !== null && key.version !== run.keyVersion) {
    return {
      ok: false,
      reason: 'Your OpenAI key was replaced while this check waited. Re-run QC.',
    };
  }
  if (key.status === 'disabled')
    return {
      ok: false,
      reason: 'Your OpenAI key is disabled. Enter it again in Settings, then re-run QC.',
    };
  return { ok: true, key };
}

/**
 * Opens an OpenAI key for one transcription and reports what the call told about it. Opened by key ID in the worker only
 * (layer rule L3), zeroed after the call; no transaction is open while the callback runs.
 */
@Injectable()
export class QcKeySession {
  constructor(
    @Inject(KEY_OPENER) private readonly opener: KeyOpener,
    @Inject(QC_KEY_AUTH_REPORTER) private readonly auth: KeyAuthReporter,
  ) {}

  open(key: SealedKeyRow, log: JobLog): ProviderCredential | null {
    try {
      const apiKey = this.opener.unseal(key.sealed, {
        userId: key.ownerId,
        provider: 'openai',
        keyId: key.id,
        version: key.version,
      });
      return { apiKey };
    } catch {
      log.warn(
        { module: 'production', outcome: 'error', keyId: key.id },
        'provider key could not be opened',
      );
      return null;
    }
  }

  async with<T>(
    key: SealedKeyRow,
    log: JobLog,
    fn: (credential: ProviderCredential) => Promise<T>,
  ): Promise<T | 'unreadable'> {
    const credential = this.open(key, log);
    if (credential === null) return 'unreadable';
    try {
      return await fn(credential);
    } finally {
      credential.apiKey.fill(0);
    }
  }

  async report(key: SealedKeyRow, ok: boolean, log: JobLog): Promise<void> {
    try {
      await this.auth.report(key.id, key.version, ok);
    } catch {
      log.warn(
        { module: 'production', outcome: 'error', keyId: key.id },
        'key auth result could not be recorded',
      );
    }
  }
}
