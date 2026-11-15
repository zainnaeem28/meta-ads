import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DomainError } from './domain-error.js';
import { CURSOR_TTL_MS, buildPage, decodeCursor, encodeCursor, filterHash } from './cursor.js';

const KEY = 'k'.repeat(40);
const OTHER_KEY = 'q'.repeat(40);
const OWNER = '0198a5e0-0000-7000-8000-000000000001';
const scope = { owner: OWNER, filters: { status: 'open', sort: 'created' } };
const T0 = new Date('2026-06-01T00:00:00Z');
const at = (ms: number) => () => new Date(T0.getTime() + ms);

function rejected(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a rejection');
}

function expectCursorRefusal(fn: () => unknown): void {
  const error = rejected(fn);
  expect(error.code).toBe('validation_failed');
  expect(error.status).toBe(400);
  expect(error.details).toEqual([expect.objectContaining({ field: 'cursor', code: 'cursor_invalid' })]);
}

describe('cursor (ADR-011)', () => {
  const token = encodeCursor(KEY, scope, '2026-05-31T10:00:00.000Z|abc', at(0));

  it('round-trips the sort key and fits the 512 limit', () => {
    expect(token.length).toBeLessThanOrEqual(512);
    expect(decodeCursor(KEY, token, scope, at(1000))).toBe('2026-05-31T10:00:00.000Z|abc');
  });

  it('is independent of filter key order', () => {
    expect(filterHash({ a: 1, b: [1, { y: 2, x: undefined }] })).toBe(filterHash({ b: [1, { y: 2 }], a: 1 }));
    expect(decodeCursor(KEY, token, { owner: OWNER, filters: { sort: 'created', status: 'open' } }, at(0))).toBeTruthy();
  });

  it('rejects a tampered payload and a tampered signature', () => {
    const [body = '', mac = ''] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), s: 'zzz' })).toString('base64url');
    expectCursorRefusal(() => decodeCursor(KEY, `${forged}.${mac}`, scope, at(0)));
    expectCursorRefusal(() => decodeCursor(KEY, `${body}.${mac.slice(0, -2)}AA`, scope, at(0)));
    expectCursorRefusal(() => decodeCursor(OTHER_KEY, token, scope, at(0)));
  });

  it('rejects an expired cursor (24 h)', () => {
    expect(decodeCursor(KEY, token, scope, at(CURSOR_TTL_MS - 1))).toBeTruthy();
    expectCursorRefusal(() => decodeCursor(KEY, token, scope, at(CURSOR_TTL_MS)));
  });

  it('rejects another owner and other filters', () => {
    expectCursorRefusal(() => decodeCursor(KEY, token, { ...scope, owner: '0198a5e0-0000-7000-8000-000000000002' }, at(0)));
    expectCursorRefusal(() => decodeCursor(KEY, token, { ...scope, filters: { status: 'closed', sort: 'created' } }, at(0)));
    expectCursorRefusal(() => decodeCursor(KEY, token, { owner: OWNER }, at(0)));
  });

  it('rejects garbage of every shape', () => {
    for (const bad of [undefined, null, 5, '', 'abc', 'a.b.c', 'x'.repeat(513), '.', `${'e30'}.${token.split('.')[1]}`]) {
      expectCursorRefusal(() => decodeCursor(KEY, bad, scope, at(0)));
    }
    const body = Buffer.from('not json').toString('base64url');
    
    const mac = createHmac('sha256', KEY).update(body).digest('base64url');
    expectCursorRefusal(() => decodeCursor(KEY, `${body}.${mac}`, scope, at(0)));
  });

  it('refuses to issue a cursor longer than 512', () => {
    expect(() => encodeCursor(KEY, scope, 'x'.repeat(600))).toThrow(RangeError);
  });

  it('fresh default clock works', () => {
    expect(decodeCursor(KEY, encodeCursor(KEY, scope, 's'), scope)).toBe('s');
  });
});

describe('buildPage', () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: String(i).padStart(3, '0') }));

  it('N rows give one page; N+1 give two pages with no repeat and no gap', () => {
    const exact = buildPage(rows.slice(0, 10), 10, (r) => r.id, KEY, scope, at(0));
    expect(exact.pagination).toEqual({ type: 'cursor', limit: 10, returnedCount: 10, hasNextPage: false, nextCursor: null });

    const first = buildPage(rows, 10, (r) => r.id, KEY, scope, at(0));
    expect(first.items.map((r) => r.id)).toEqual(rows.slice(0, 10).map((r) => r.id));
    expect(first.pagination.hasNextPage).toBe(true);
    const after = decodeCursor(KEY, first.pagination.nextCursor, scope, at(1));
    expect(after).toBe('009');
    const rest = rows.filter((r) => r.id > after);
    const second = buildPage(rest, 10, (r) => r.id, KEY, scope, at(1));
    expect(second.items.map((r) => r.id)).toEqual(['010']);
    expect(second.pagination).toMatchObject({ hasNextPage: false, nextCursor: null, returnedCount: 1 });
  });

  it('an empty result has no next page', () => {
    expect(buildPage([], 10, () => '', KEY, scope).pagination).toMatchObject({ returnedCount: 0, hasNextPage: false, nextCursor: null });
  });
});
