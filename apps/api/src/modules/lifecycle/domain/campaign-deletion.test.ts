import { describe, expect, it } from 'vitest';
import { errorClassOf, ledgerBodyOf, ledgerKeyOf, nextOnFailure, verifyDelayMs } from './campaign-deletion.js';

describe('campaign deletion rules', () => {
  it('builds the ledger key from the run time and id, and the body from IDs and kind only', () => {
    expect(ledgerKeyOf('2026-11-17 10:20:30.123456+00', 'r1')).toBe('erasure/2026-11-17T10-20-30-123Z-r1');
    const body = JSON.parse(ledgerBodyOf({ id: 'r1', kind: 'campaign', subjectId: 's1' })) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['kind', 'runId', 'subjectId']);
  });

  it('waits the longest deadline plus the grace', () => {
    expect(verifyDelayMs(30, 60)).toBe(31 * 60 * 1000);
  });

  it('counts failures and sticks at the limit', () => {
    expect(nextOnFailure(0, 3)).toEqual({ attempts: 1, stuck: false });
    expect(nextOnFailure(2, 3)).toEqual({ attempts: 3, stuck: true });
  });

  it('classifies an error by its name only', () => {
    expect(errorClassOf(new TypeError('secret u/abc'))).toBe('TypeError');
    expect(errorClassOf('x')).toBe('Error');
  });
});
