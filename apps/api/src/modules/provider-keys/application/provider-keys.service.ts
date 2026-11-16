import { Inject, Injectable } from '@nestjs/common';
import { AuditService, ALERT_PORT } from '../../audit/index.js';
import type { AlertPort } from '../../audit/index.js';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/index.js';
import { RateLimitedError } from '../../../platform/rate-limit/index.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { checkKeyFormat, lastFour, normalizeKey } from '../domain/key-policy.js';
import type { FormatProblem, KeyEventKind, KeyStatus } from '../domain/key-policy.js';
import { KEY_WRAP_PORT, PROVIDERS } from '../domain/key-wrap.js';
import type { KeyWrapPort, Provider } from '../domain/key-wrap.js';
import { PROVIDER_PROBE_PORT } from '../domain/provider-probe.js';
import type { ProviderProbePort } from '../domain/provider-probe.js';
import {
  FINGERPRINTER,
  IN_FLIGHT_JOB_READER,
  KEY_ENTRY_LIMITER,
  KEY_EVENT_REPOSITORY,
  KEY_POLICY,
  PROVIDER_KEY_REPOSITORY,
} from './ports.js';
import type {
  EntryLimiter,
  Executor,
  Fingerprinter,
  InFlightJobReader,
  KeyEventQuery,
  KeyEventRecord,
  KeyEventRepository,
  KeyPolicy,
  KeyRecord,
  KeyWrite,
  ProviderKeyRepository,
} from './ports.js';

/** Rate-limit bucket of key entry; the subject is the account (`key-entry:{userId}`, ARCHITECTURE §5.2). */
export const KEY_ENTRY_SCOPE = 'key-entry';

/** The whole stored key shown to its owner: hint and fingerprint only, never a value (REQ-014, REQ-016). */
export interface KeyStatusView {
  readonly provider: Provider;
  readonly configured: boolean;
  readonly status: KeyStatus | null;
  readonly last4: string | null;
  /** First 12 hex characters of the HMAC. */
  readonly fingerprint: string | null;
  readonly version: number | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly lastValidatedAt: string | null;
  readonly inFlightJobCount: number;
}

export interface StoredKeyView extends KeyStatusView {
  /** `unknown` means the key was stored as `untested`. */
  readonly probe: 'valid' | 'unknown';
}

export interface RequestContext {
  readonly requestId?: string;
}

const FORMAT_MESSAGES: Record<FormatProblem | 'rejected', string> = {
  format: 'The key does not look like a key for this provider.',
  wrong_provider: 'This looks like a key for a different provider.',
  rejected: 'The provider did not accept this key.',
};

const keyInvalid = (reason: FormatProblem | 'rejected'): DomainError =>
  new DomainError('key_invalid', 'The key could not be accepted.', [
    { field: 'apiKey', code: reason, message: FORMAT_MESSAGES[reason] },
  ]);

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Provider keys of an account (REQ-014..019): the api seals and stores, never reads a key back, and shows a hint and a
 * fingerprint only. One transaction per write; the provider call is made before it opens (no network call inside one).
 */
@Injectable()
export class ProviderKeysService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'db' | 'uow'>,
    @Inject(PROVIDER_KEY_REPOSITORY) private readonly keys: ProviderKeyRepository,
    @Inject(KEY_EVENT_REPOSITORY) private readonly events: KeyEventRepository,
    @Inject(PROVIDER_PROBE_PORT) private readonly probePort: ProviderProbePort,
    @Inject(KEY_WRAP_PORT) private readonly wrap: KeyWrapPort,
    @Inject(FINGERPRINTER) private readonly fingerprints: Fingerprinter,
    @Inject(IN_FLIGHT_JOB_READER) private readonly inFlight: InFlightJobReader,
    @Inject(KEY_ENTRY_LIMITER) private readonly limiter: EntryLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(KEY_POLICY) private readonly policy: KeyPolicy,
  ) {}

  private async view(record: KeyRecord | undefined, provider: Provider, ownerId: string): Promise<KeyStatusView> {
    const inFlightJobCount = record === undefined ? 0 : await this.inFlightJobCount(ownerId, provider);
    return {
      provider,
      configured: record !== undefined,
      status: record?.status ?? null,
      last4: record?.last4 ?? null,
      fingerprint: record?.fingerprint.slice(0, 12) ?? null,
      version: record?.version ?? null,
      createdAt: iso(record?.createdAt ?? null),
      updatedAt: iso(record?.updatedAt ?? null),
      lastValidatedAt: iso(record?.lastValidatedAt ?? null),
      inFlightJobCount,
    };
  }

  /** API-010: one entry per provider, configured or not. */
  async keyStatus(ownerId: string): Promise<KeyStatusView[]> {
    const records = await this.keys.list(this.database.db, ownerId);
    return Promise.all(
      PROVIDERS.map((provider) => this.view(records.find((r) => r.provider === provider), provider, ownerId)),
    );
  }

  /** Jobs in flight on the owner's key; the screen warns before a replacement or a deletion when it is above zero. */
  inFlightJobCount(ownerId: string, provider: Provider): Promise<number> {
    return this.inFlight.countForKey(ownerId, provider);
  }

  /** A refused attempt leaves one event (not one per refused request: the first refusal of a window). */
  private async enforceAttemptLimit(ownerId: string, provider: Provider): Promise<void> {
    const result = await this.limiter.consume(
      KEY_ENTRY_SCOPE,
      ownerId,
      this.policy.attemptsPerWindow,
      this.policy.windowMinutes * 60,
    );
    if (result.allowed) return;
    if (result.count === result.limit + 1) {
      await this.events.insert(this.database.db, { ownerId, keyId: null, provider, kind: 'attempt_rate_limited' });
    }
    throw new RateLimitedError(result.retryAfterSeconds);
  }

  /**
   * API-011 (ARCHITECTURE §5.2): attempt limit, trim and format check, probe outside any transaction, seal, then one
   * transaction that inserts the first key or replaces conditionally on `version`. A key that fails any step leaves the
   * stored key unchanged.
   */
  async storeKey(
    ownerId: string,
    provider: Provider,
    rawKey: string,
    context: RequestContext = {},
  ): Promise<StoredKeyView> {
    await this.enforceAttemptLimit(ownerId, provider);
    const key = normalizeKey(rawKey);
    const problem = checkKeyFormat(provider, key, this.policy.formats);
    if (problem !== undefined) await this.refuse(ownerId, provider, problem);
    const probe = await this.probePort.probe(provider, key);
    if (probe === 'invalid') await this.refuse(ownerId, provider, 'rejected');
    const verdict: 'valid' | 'unknown' = probe === 'valid' ? 'valid' : 'unknown';
    const plaintext = Buffer.from(key, 'utf8');
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const stored = await this.persist(ownerId, provider, key, plaintext, verdict, context);
        if (stored !== undefined) return { ...(await this.view(stored, provider, ownerId)), probe: verdict };
      }
    } finally {
      plaintext.fill(0);
    }
    throw new DomainError('state_conflict', 'The key was changed by another request. Try again.');
  }

  private async refuse(ownerId: string, provider: Provider, reason: FormatProblem | 'rejected'): Promise<never> {
    await this.events.insert(this.database.db, { ownerId, keyId: null, provider, kind: 'test_failed' });
    throw keyInvalid(reason);
  }

  /** One pass of step 4 and 5; `undefined` when a concurrent request got in between the read and the write. */
  private async persist(
    ownerId: string,
    provider: Provider,
    key: string,
    plaintext: Buffer,
    verdict: 'valid' | 'unknown',
    context: RequestContext,
  ): Promise<KeyRecord | undefined> {
    const existing = await this.keys.find(this.database.db, ownerId, provider);
    const id = existing?.id ?? newId();
    const version = (existing?.version ?? 0) + 1;
    const sealed = this.wrap.seal(plaintext, { userId: ownerId, provider, keyId: id, version });
    const print = this.fingerprints.fingerprint(plaintext);
    const write: KeyWrite = {
      status: verdict === 'valid' ? 'active' : 'untested',
      version,
      sealed,
      last4: lastFour(key),
      fingerprint: print.hex,
      fingerprintPepperVersion: print.pepperVersion,
      validatedAt: verdict === 'valid' ? new Date() : null,
    };
    return this.database.uow.run(async (tx) => {
      const written =
        existing === null
          ? await this.keys.insert(tx, id, ownerId, provider, write)
          : await this.keys.replace(tx, id, existing.version, write);
      if (!written) return undefined;
      await this.event(tx, ownerId, id, provider, verdict === 'valid' ? 'test_passed' : 'stored_untested');
      await this.event(tx, ownerId, id, provider, existing === null ? 'added' : 'replaced');
      await this.audit.record(tx, {
        actorId: ownerId,
        actorType: 'user',
        action: existing === null ? 'key.added' : 'key.replaced',
        objectType: 'provider_key',
        objectId: id,
        outcome: 'allowed',
        requestId: context.requestId ?? null,
      });
      return this.keys.find(tx, ownerId, provider).then((row) => row ?? undefined);
    });
  }

  private event(
    db: Executor,
    ownerId: string,
    keyId: string | null,
    provider: Provider,
    kind: KeyEventKind,
  ): Promise<void> {
    return this.events.insert(db, { ownerId, keyId, provider, kind });
  }

  /** API-012: hard delete (the sealed values go with the row). Jobs in flight fail lazily with `key_deleted`. */
  async deleteKey(ownerId: string, provider: Provider, context: RequestContext = {}): Promise<void> {
    await this.database.uow.run(async (tx) => {
      const id = await this.keys.delete(tx, ownerId, provider);
      if (id === null) throw new DomainError('not_found', 'No key is stored for this provider.');
      await this.event(tx, ownerId, id, provider, 'deleted');
      await this.audit.record(tx, {
        actorId: ownerId,
        actorType: 'user',
        action: 'key.deleted',
        objectType: 'provider_key',
        objectId: id,
        outcome: 'allowed',
        requestId: context.requestId ?? null,
      });
    });
  }

  /** Account erasure (lifecycle, REQ-031): in the caller's transaction, every key of the owner and one event each. */
  async deleteAllForOwner(tx: Executor, ownerId: string): Promise<number> {
    const removed = await this.keys.deleteAll(tx, ownerId);
    for (const { id, provider } of removed) await this.event(tx, ownerId, id, provider, 'deleted');
    return removed.length;
  }

  /** The owner's key trail, newest first. */
  listEvents(ownerId: string, query: KeyEventQuery): Promise<KeyEventRecord[]> {
    return this.events.list(this.database.db, ownerId, query);
  }

  /**
   * `keys:disable-all` (incident runbook): every live key becomes `disabled`, one `disabled_by_operator` event each, one
   * audit event and one `keys_disabled_all` alert (announced after the commit).
   */
  async disableAll(): Promise<number> {
    const pending = await this.database.uow.run(async (tx) => {
      const disabled = await this.keys.disableAll(tx);
      for (const { id, ownerId, provider } of disabled) {
        await this.event(tx, ownerId, id, provider, 'disabled_by_operator');
      }
      await this.audit.record(tx, {
        actorId: null,
        actorType: 'operator',
        action: 'key.disabled_all',
        objectType: 'provider_key',
        objectId: null,
        outcome: 'allowed',
      });
      const alert = await this.alerts.raiseAlert(tx, 'keys_disabled_all', null, { keys: disabled.length });
      return { alert, count: disabled.length };
    });
    pending.alert.announce();
    return pending.count;
  }

  /**
   * The worker's report of a provider call made with this version of the key (ARCHITECTURE §5.2). A 401 counts toward
   * the threshold; a success resets the count and lets the first one turn `untested` into `active`. A report about a
   * key that has since been replaced or deleted counts for nothing.
   */
  async recordAuthResult(keyId: string, version: number, ok: boolean): Promise<void> {
    await this.database.uow.run(async (tx) => {
      if (ok) {
        const done = await this.keys.recordSuccess(tx, keyId, version);
        if (done?.activated === true) {
          await this.event(tx, done.row.ownerId, keyId, done.row.provider, 'validated_by_job');
        }
        return;
      }
      const row = await this.keys.recordFailure(tx, keyId, version, this.policy.autoDisableThreshold);
      if (row === null) return;
      await this.event(tx, row.ownerId, keyId, row.provider, 'auth_failed');
      if (row.status !== 'disabled') return;
      await this.event(tx, row.ownerId, keyId, row.provider, 'disabled');
      await this.audit.record(tx, {
        actorId: null,
        actorType: 'system',
        action: 'key.disabled',
        objectType: 'provider_key',
        objectId: keyId,
        outcome: 'allowed',
      });
    });
  }
}
