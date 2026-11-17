import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DomainError } from '../http/domain-error.js';
import type { DbTx } from '../db/index.js';

export const DEFAULT_TTL_HOURS = 24;
export const MAX_KEY_LENGTH = 128;

export interface IdempotencyScope {
  readonly ownerId: string;
  readonly operationId: string;
  readonly key: string;
  /** `requestHash(method, path, body)`. */
  readonly requestHash: Buffer;
}

export interface StoredResource {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly responseStatus: number;
}

export type IdempotentOutcome<T> =
  | ({ readonly replayed: false; readonly result: T } & StoredResource)
  | ({ readonly replayed: true } & StoredResource);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([name, member]) => `${JSON.stringify(name)}:${canonical(member)}`).join(',')}}`;
}

/** SHA-256 of method, path and canonical JSON body (key order does not matter). */
export function requestHash(method: string, path: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonical(body)}`)
    .digest();
}

/** The `Idempotency-Key` header: required on the operations that ask for it (400 `validation_failed` when absent or malformed). */
export function parseIdempotencyKey(header: string | readonly string[] | undefined): string {
  const value = Array.isArray(header) ? undefined : (header as string | undefined)?.trim();
  if (value === undefined || value === '') {
    throw new DomainError('validation_failed', 'The Idempotency-Key header is required.', [
      {
        field: 'Idempotency-Key',
        code: 'required',
        message: 'Send a unique Idempotency-Key header.',
      },
    ]);
  }
  if (value.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(value)) {
    throw new DomainError('validation_failed', 'The Idempotency-Key header is not valid.', [
      {
        field: 'Idempotency-Key',
        code: 'invalid',
        message: `Use 1 to ${MAX_KEY_LENGTH} visible ASCII characters.`,
      },
    ]);
  }
  return value;
}

interface RecordRow extends Record<string, unknown> {
  request_hash: Buffer;
  resource_type: string;
  resource_id: string;
  response_status: number;
}

const toStored = (row: RecordRow): StoredResource => ({
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  responseStatus: Number(row.response_status),
});

/**
 * The live (unexpired) record of a key, or undefined. Also the lookup the job-creation use case runs before the
 * reuse-index check (SB-D14).
 */
export async function lookupRecord(
  tx: DbTx,
  scope: Pick<IdempotencyScope, 'ownerId' | 'operationId' | 'key'>,
): Promise<(StoredResource & { requestHash: Buffer }) | undefined> {
  const result = await tx.execute<RecordRow>(sql`
    select request_hash, resource_type, resource_id, response_status from idempotency_records
    where owner_id = ${scope.ownerId} and operation_id = ${scope.operationId} and key = ${scope.key}
      and expires_at > now()`);
  const row = result.rows[0];
  return row === undefined ? undefined : { ...toStored(row), requestHash: row.request_hash };
}

export interface IdempotentOptions extends StoredResource {
  readonly ttlHours?: number;
}

/**
 * Runs `create` once per `(owner, operation, key)`. The record is inserted first, in the caller's transaction,
 * with the resource ID the caller will create: a concurrent duplicate blocks on the primary key until this
 * transaction ends, then replays the stored resource (or runs itself if this one rolled back). The same key with
 * another request hash is 409 `idempotency_key_reused`.
 */
export async function withIdempotency<T>(
  tx: DbTx,
  scope: IdempotencyScope,
  options: Omit<IdempotentOptions, 'resourceId'> & { readonly resourceId?: string },
  create: (resourceId: string) => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;
  const resourceId = options.resourceId ?? randomUUID();
  // An expired record that cleanup has not removed yet no longer counts.
  await tx.execute(sql`
    delete from idempotency_records
    where owner_id = ${scope.ownerId} and operation_id = ${scope.operationId} and key = ${scope.key}
      and expires_at <= now()`);
  const inserted = await tx.execute(sql`
    insert into idempotency_records
      (owner_id, operation_id, key, request_hash, resource_type, resource_id, response_status, expires_at)
    values (${scope.ownerId}, ${scope.operationId}, ${scope.key}, ${scope.requestHash}, ${options.resourceType},
            ${resourceId}, ${options.responseStatus}, now() + make_interval(hours => ${ttlHours}))
    on conflict (owner_id, operation_id, key) do nothing
    returning 1`);
  if (inserted.rows.length === 1) {
    const result = await create(resourceId);
    return {
      replayed: false,
      result,
      resourceType: options.resourceType,
      resourceId,
      responseStatus: options.responseStatus,
    };
  }
  const existing = await lookupRecord(tx, scope);
  if (existing === undefined) {
    // Expired between the conflict and the read: the key is free again.
    return withIdempotency(tx, scope, options, create);
  }
  if (!existing.requestHash.equals(scope.requestHash)) {
    throw new DomainError(
      'idempotency_key_reused',
      'This request key was already used for a different request.',
    );
  }
  return {
    replayed: true,
    resourceType: existing.resourceType,
    resourceId: existing.resourceId,
    responseStatus: existing.responseStatus,
  };
}
