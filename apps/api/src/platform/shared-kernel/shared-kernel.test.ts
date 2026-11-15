import { describe, expect, it } from 'vitest';
import { DomainErrorBase, err, isUuidV7, mapResult, newId, ok, unwrap } from './index.js';

describe('shared-kernel', () => {
  it('newId is a UUIDv7 and ids sort by creation time', async () => {
    const a = newId();
    await new Promise((r) => setTimeout(r, 3));
    const b = newId();
    expect(isUuidV7(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(isUuidV7('0198a5e0-0000-4000-8000-000000000001')).toBe(false);
    expect(isUuidV7(5)).toBe(false);
  });

  it('Result carries a value or an error', () => {
    expect(unwrap(ok(3))).toBe(3);
    expect(() => unwrap(err(new Error('bad')))).toThrow('bad');
    expect(mapResult(ok(2), (n) => n * 2)).toEqual({ ok: true, value: 4 });
    const failed = err('e');
    expect(mapResult(failed, () => 1)).toBe(failed);
  });

  it('DomainErrorBase keeps code, safe message and details', () => {
    class Mine extends DomainErrorBase {}
    const e = new Mine('x', 'safe', [{ field: 'f', code: 'c', message: 'm' }]);
    expect(e).toMatchObject({ code: 'x', safeMessage: 'safe', message: 'safe', name: 'Mine' });
    expect(e.details).toHaveLength(1);
  });
});
