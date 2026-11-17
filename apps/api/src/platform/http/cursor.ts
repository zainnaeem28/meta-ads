import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from './domain-error.js';
import { PageResult } from './response.js';
import type { CursorPagination } from './response.js';

/** ADR-011: signed, forward-only, 24 h. HMAC-SHA-256 over owner, sort key, filter hash and expiry. */
export const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CURSOR_LENGTH = 512;

export interface CursorScope {
  /** The user the list belongs to; a cursor is never valid for another owner. */
  owner: string;
  /** Everything that changes the result set (filters, sort name); a cursor is never valid for other filters. */
  filters?: unknown;
}

interface Payload {
  o: string;
  s: string;
  f: string;
  e: number;
}

const b64 = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function filterHash(filters: unknown): string {
  return b64(
    createHash('sha256')
      .update(canonical(filters ?? null))
      .digest(),
  );
}

const sign = (key: string, body: string): Buffer => createHmac('sha256', key).update(body).digest();

export function invalidCursor(): DomainError {
  return new DomainError('validation_failed', 'The request is not valid.', [
    { field: 'cursor', code: 'cursor_invalid', message: 'The cursor is invalid or has expired.' },
  ]);
}

export function encodeCursor(
  key: string,
  scope: CursorScope,
  sortKey: string,
  now: () => Date = () => new Date(),
): string {
  const payload: Payload = {
    o: scope.owner,
    s: sortKey,
    f: filterHash(scope.filters),
    e: now().getTime() + CURSOR_TTL_MS,
  };
  const body = b64(JSON.stringify(payload));
  const token = `${body}.${b64(sign(key, body))}`;
  if (token.length > MAX_CURSOR_LENGTH) throw new RangeError('sort key too long for a cursor');
  return token;
}

/** The sort key of the last item of the previous page, or a 400 `validation_failed` (detail `cursor`). */
export function decodeCursor(
  key: string,
  token: unknown,
  scope: CursorScope,
  now: () => Date = () => new Date(),
): string {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor();
  }
  const parts = token.split('.');
  const [body, mac] = parts;
  if (parts.length !== 2 || body === undefined || mac === undefined) throw invalidCursor();
  const given = Buffer.from(mac, 'base64url');
  const expected = sign(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalidCursor();
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
  } catch {
    throw invalidCursor();
  }
  if (
    typeof payload.o !== 'string' ||
    typeof payload.s !== 'string' ||
    typeof payload.f !== 'string' ||
    typeof payload.e !== 'number' ||
    payload.e <= now().getTime() ||
    payload.o !== scope.owner ||
    payload.f !== filterHash(scope.filters)
  ) {
    throw invalidCursor();
  }
  return payload.s;
}

/**
 * Build a page from rows fetched with `limit + 1`: the extra row only proves another page exists.
 * The next cursor carries the sort key of the last row that is returned.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  sortKeyOf: (row: T) => string,
  key: string,
  scope: CursorScope,
  now?: () => Date,
): PageResult<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const hasNextPage = rows.length > limit && last !== undefined;
  const pagination: CursorPagination = {
    type: 'cursor',
    limit,
    returnedCount: items.length,
    hasNextPage,
    nextCursor: hasNextPage ? encodeCursor(key, scope, sortKeyOf(last), now) : null,
  };
  return new PageResult(items, pagination);
}
