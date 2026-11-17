import type { DbTx } from '../../../platform/db/index.js';
import type { KeyEventKind, KeyFormats, KeyStatus } from '../domain/key-policy.js';
import type { Provider, Sealed } from '../domain/key-wrap.js';

/** A transaction handle, or the pool-backed database for a single statement (a refused attempt has no transaction). */
export type Executor = Pick<DbTx, 'select' | 'insert' | 'update' | 'delete'>;

/** The non-secret columns of a stored key: ciphertext, nonce and wrapped key are never read back (ADR-009). */
export interface KeyRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: Provider;
  readonly status: KeyStatus;
  readonly version: number;
  readonly last4: string;
  /** Full lower-hex HMAC; the API shows its first 12 characters. */
  readonly fingerprint: string;
  readonly consecutiveAuthFailures: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastValidatedAt: Date | null;
}

/** What a store or a replacement writes. `validatedAt` is set when the probe accepted the key. */
export interface KeyWrite {
  readonly status: Exclude<KeyStatus, 'disabled'>;
  readonly version: number;
  readonly sealed: Sealed;
  readonly last4: string;
  readonly fingerprint: string;
  readonly fingerprintPepperVersion: number;
  readonly validatedAt: Date | null;
}

export interface KeyEventInput {
  readonly ownerId: string;
  readonly keyId: string | null;
  readonly provider: Provider;
  readonly kind: KeyEventKind;
}

export interface KeyEventRecord {
  readonly id: string;
  readonly provider: Provider;
  readonly kind: KeyEventKind;
  /** PostgreSQL timestamptz text with microseconds, e.g. `2026-11-15 23:53:22.123456+00`. */
  readonly at: string;
}

/** Position after the last event of a page, in the order of `key_events_owner_at_idx`. */
export interface KeyEventPosition {
  readonly at: string;
  readonly id: string;
}

export interface KeyEventQuery {
  readonly provider?: Provider;
  readonly limit: number;
  readonly after?: KeyEventPosition;
}

/** The key a worker reported on, with whom it belongs to (for the event and the audit entry). */
export interface AuthResultRow {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: Provider;
  readonly status: KeyStatus;
  readonly consecutiveAuthFailures: number;
}

/** Module-private persistence of `provider_keys`; other modules never see it. */
export interface ProviderKeyRepository {
  find(db: Executor, ownerId: string, provider: Provider): Promise<KeyRecord | null>;
  list(db: Executor, ownerId: string): Promise<KeyRecord[]>;
  /** False when the owner already has a key for the provider (a concurrent first store). */
  insert(
    db: Executor,
    id: string,
    ownerId: string,
    provider: Provider,
    write: KeyWrite,
  ): Promise<boolean>;
  /** Conditional on `expectedVersion`; false when another request replaced or deleted the row first. */
  replace(db: Executor, id: string, expectedVersion: number, write: KeyWrite): Promise<boolean>;
  delete(db: Executor, ownerId: string, provider: Provider): Promise<string | null>;
  deleteAll(db: Executor, ownerId: string): Promise<{ id: string; provider: Provider }[]>;
  /** Counts one authentication failure of this version of the key; disables it at `threshold`. Null when no such live key. */
  recordFailure(
    db: Executor,
    id: string,
    version: number,
    threshold: number,
  ): Promise<AuthResultRow | null>;
  /** Resets the count (and sets `untested` to `active`); `activated` is true when the status changed. Null when no such live key. */
  recordSuccess(
    db: Executor,
    id: string,
    version: number,
  ): Promise<{ row: AuthResultRow; activated: boolean } | null>;
  disableAll(db: Executor): Promise<{ id: string; ownerId: string; provider: Provider }[]>;
}

export interface KeyEventRepository {
  insert(db: Executor, event: KeyEventInput): Promise<void>;
  list(db: Executor, ownerId: string, query: KeyEventQuery): Promise<KeyEventRecord[]>;
}

/** Injected by bootstrap and implemented by brief and production (SB §4.2): provider-keys never imports them. */
export interface InFlightJobReader {
  /** Jobs submitting, submitted or processing on the owner's key for the provider. */
  countForKey(ownerId: string, provider: Provider): Promise<number>;
}

export interface Fingerprinter {
  /** Lower hex HMAC-SHA-256 of the key under the active pepper, with the pepper version that made it. */
  fingerprint(key: Buffer): { readonly hex: string; readonly pepperVersion: number };
}

/** Counts one key-entry attempt of an account (REQ-014: 5 per 10 minutes). */
export interface EntryLimiter {
  consume(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; count: number; limit: number; retryAfterSeconds: number }>;
}

/** Configuration of the module, read once at startup (ARCHITECTURE §6). */
export interface KeyPolicy {
  readonly attemptsPerWindow: number;
  readonly windowMinutes: number;
  /** Consecutive provider 401s that disable a key (`KEY_AUTO_DISABLE_THRESHOLD`). */
  readonly autoDisableThreshold: number;
  readonly formats: KeyFormats;
}

export const PROVIDER_KEY_REPOSITORY = Symbol('PROVIDER_KEY_REPOSITORY');
export const KEY_EVENT_REPOSITORY = Symbol('KEY_EVENT_REPOSITORY');
export const IN_FLIGHT_JOB_READER = Symbol('IN_FLIGHT_JOB_READER');
export const FINGERPRINTER = Symbol('FINGERPRINTER');
export const KEY_ENTRY_LIMITER = Symbol('KEY_ENTRY_LIMITER');
export const KEY_POLICY = Symbol('KEY_POLICY');
