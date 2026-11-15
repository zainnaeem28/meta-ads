import { describe, expect, it } from 'vitest';
import { IdempotencyKeys, idempotencyHeaders } from './idempotency';

describe('IdempotencyKeys', () => {
  it('reuses the key only for a retry of the same payload', () => {
    const keys = new IdempotencyKeys();
    const first = keys.keyFor({ a: 1, b: { x: [1, 2], y: 2 } });
    expect(keys.keyFor({ b: { y: 2, x: [1, 2] }, a: 1 })).toBe(first); // same payload, key order irrelevant
    expect(keys.keyFor({ a: 2 })).not.toBe(first); // edited payload: new action
  });

  it('issues a new key after a success, even for an identical payload', () => {
    const keys = new IdempotencyKeys();
    const first = keys.keyFor({ a: 1 });
    keys.succeeded();
    expect(keys.keyFor({ a: 1 })).not.toBe(first);
  });

  it('does not share keys between actions', () => {
    expect(new IdempotencyKeys().keyFor({ a: 1 })).not.toBe(new IdempotencyKeys().keyFor({ a: 1 }));
  });

  it('builds the header', () => {
    expect(idempotencyHeaders('k')).toEqual({ headers: { 'Idempotency-Key': 'k' } });
  });
});
