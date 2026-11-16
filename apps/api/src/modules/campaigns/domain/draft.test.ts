import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../platform/http/domain-error.js';
import { assertAudience, durationSeconds } from './draft.js';

describe('durationSeconds (TC-INT-02)', () => {
  it('is 15 seconds per segment, 1 to 4 segments', () => {
    expect([1, 2, 3, 4].map((segmentCount) => durationSeconds({ segmentCount }))).toEqual([15, 30, 45, 60]);
  });
  it('is null without a direction or a count', () => {
    expect(durationSeconds(null)).toBeNull();
    expect(durationSeconds({ goal: 'awareness' })).toBeNull();
  });
});

describe('assertAudience', () => {
  it('accepts a missing audience, a partial one and an ordered range', () => {
    expect(() => assertAudience(undefined)).not.toThrow();
    expect(() => assertAudience(null)).not.toThrow();
    expect(() => assertAudience({ ageMin: 30 })).not.toThrow();
    expect(() => assertAudience({ ageMax: 30 })).not.toThrow();
    expect(() => assertAudience({ ageMin: 35, ageMax: 35 })).not.toThrow();
  });
  it('refuses a maximum below the minimum with a field error', () => {
    try {
      assertAudience({ ageMin: 40, ageMax: 30 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('validation_failed');
      expect((error as DomainError).details?.[0]).toMatchObject({ field: 'audience.ageMax', code: 'out_of_range' });
    }
  });
});
