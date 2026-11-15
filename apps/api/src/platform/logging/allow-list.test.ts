import { describe, expect, it } from 'vitest';
import { ALLOWED_FIELDS, filterFields, isAllowedField } from './allow-list.js';

describe('allow-list (TC-LOG-03)', () => {
  it('lists exactly the fields of ARCHITECTURE 3.7', () => {
    expect([...ALLOWED_FIELDS]).toEqual([
      'time',
      'level',
      'msg',
      'requestId',
      'correlationId',
      'route',
      'method',
      'status',
      'durationMs',
      'code',
      'module',
      'userId',
      'jobId',
      'jobType',
      'provider',
      'outcome',
      'latencyMs',
      'releaseSha',
    ]);
  });

  it('rejects an unlisted field', () => {
    expect(isAllowedField('transcript')).toBe(false);
    const kept = filterFields(
      { requestId: 'abc-12345678', transcript: 'hello', imageDescription: 'a face', req: { a: 1 } },
      (v) => v,
    );
    expect(kept).toEqual({ requestId: 'abc-12345678' });
  });

  it('keeps primitives, scrubs strings and drops objects under a listed name', () => {
    const kept = filterFields(
      { msg: 'x', status: 200, outcome: null, module: { nested: true }, route: ['a'], code: 'E_X' },
      (v) => v.toUpperCase(),
    );
    expect(kept).toEqual({ msg: 'X', status: 200, outcome: null, code: 'E_X' });
    expect(filterFields({ ok: true } as never, (v) => v)).toEqual({});
  });
});
