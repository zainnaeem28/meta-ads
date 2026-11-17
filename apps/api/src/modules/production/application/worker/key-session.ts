import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database } from '../../../../platform/db/index.js';
import { KEY_AUTH_REPORTER, KEY_OPENER, VIDEO_WORKER_REPOSITORY } from './ports.js';
import type { JobLog, KeyAuthReporter, KeyOpener, ProviderCredential, SealedKeyRow, VideoCause, VideoJobRow, VideoWorkerRepository } from './ports.js';

export type KeyGate =
  | { readonly ok: true; readonly key: SealedKeyRow }
  | { readonly ok: false; readonly cause: VideoCause; readonly message: string };

/**
 * The claim guard on the key (ARCHITECTURE §5.5): the row the job was created with must still exist, belong to the
 * owner, be a WaveSpeed key of the same version and not be disabled. Any other state means no call and no charge.
 */
export function gateKey(job: VideoJobRow, key: SealedKeyRow | null): KeyGate {
  if (job.keyId === null || key === null || key.ownerId !== job.ownerId) {
    return { ok: false, cause: 'key_deleted', message: 'The WaveSpeed key this clip used was removed. Add a key and try again.' };
  }
  if (key.provider !== 'wavespeed') return { ok: false, cause: 'configuration', message: 'The key this clip used is not a WaveSpeed key.' };
  if (job.keyVersion === null || key.version !== job.keyVersion) {
    return { ok: false, cause: 'key_replaced', message: 'Your WaveSpeed key was replaced while this clip waited. Try again.' };
  }
  if (key.status === 'disabled') return { ok: false, cause: 'configuration', message: 'Your WaveSpeed key is disabled. Enter it again.' };
  return { ok: true, key };
}

/**
 * The key a free follow-up call uses (poll, output copy, provider cleanup): the same key row, whatever its version or
 * status, because the provider task already exists and only that account can read or delete it.
 */
export function followUpKey(job: Pick<VideoJobRow, 'keyId' | 'ownerId'>, key: SealedKeyRow | null): SealedKeyRow | null {
  return job.keyId === null || key === null || key.ownerId !== job.ownerId || key.provider !== 'wavespeed' ? null : key;
}

/**
 * Opens a stored key for one provider call and reports what the call told about it. The key is opened only here, by key
 * ID, in the worker, and zeroed after the call; no transaction is open while the callback runs.
 */
@Injectable()
export class KeySession {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(VIDEO_WORKER_REPOSITORY) private readonly repository: VideoWorkerRepository,
    @Inject(KEY_OPENER) private readonly opener: KeyOpener,
    @Inject(KEY_AUTH_REPORTER) private readonly auth: KeyAuthReporter,
  ) {}

  async keyOf(keyId: string): Promise<SealedKeyRow | null> {
    return this.database.uow.run((tx) => this.repository.findKey(tx, keyId));
  }

  /** Unseals the key; `null` when it cannot be read (nothing was sent). */
  open(key: SealedKeyRow, log: JobLog): ProviderCredential | null {
    try {
      const apiKey = this.opener.unseal(key.sealed, { userId: key.ownerId, provider: 'wavespeed', keyId: key.id, version: key.version });
      return { apiKey };
    } catch {
      log.warn({ module: 'production', outcome: 'error', keyId: key.id }, 'provider key could not be opened');
      return null;
    }
  }

  async with<T>(key: SealedKeyRow, log: JobLog, fn: (credential: ProviderCredential) => Promise<T>): Promise<T | 'unreadable'> {
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
      log.warn({ module: 'production', outcome: 'error', keyId: key.id }, 'key auth result could not be recorded');
    }
  }
}
