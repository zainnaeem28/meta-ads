import { describe, expect, it } from 'vitest';
import {
  correlationOf,
  isValidRequestId,
  resolveRequestId,
  responseMeta,
  withCorrelation,
} from './request-id.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request ID', () => {
  it('generates a UUIDv7 when there is no upstream value', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_V7);
  });

  it('keeps a trusted upstream value of the allowed shape', () => {
    expect(resolveRequestId('abcd-1234')).toBe('abcd-1234');
    expect(resolveRequestId(['abcd-1234', 'other'])).toBe('abcd-1234');
  });

  it.each(['short', 'a'.repeat(65), 'has space 1234', 'semi;colon-1234', 'ünïcode-1234', ''])(
    'replaces a malformed upstream value %j',
    (bad) => {
      expect(isValidRequestId(bad)).toBe(false);
      expect(resolveRequestId(bad)).toMatch(UUID_V7);
    },
  );

  it('ignores an upstream value when the upstream is not trusted', () => {
    expect(resolveRequestId('abcd-1234', false)).toMatch(UUID_V7);
  });

  it('shapes metaData for the http layer', () => {
    expect(responseMeta('abcd-1234', () => new Date('2026-01-02T03:04:05.000Z'))).toEqual({
      requestId: 'abcd-1234',
      timestamp: '2026-01-02T03:04:05.000Z',
    });
    expect(responseMeta('abcd-1234').timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('carries the request ID into a job payload as correlationId', () => {
    const payload = withCorrelation({ jobKind: 'render' }, 'abcd-1234');
    expect(payload).toEqual({ jobKind: 'render', correlationId: 'abcd-1234' });
    expect(correlationOf(payload)).toBe('abcd-1234');
    expect(correlationOf(null)).toMatch(UUID_V7);
    expect(correlationOf({ correlationId: 'bad id' })).toMatch(UUID_V7);
  });
});
