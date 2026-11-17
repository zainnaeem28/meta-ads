import { describe, expect, it } from 'vitest';
import { completeness } from './submit.service.js';
import { reuseHashOf } from './submit-jobs.js';
import { instant, jobSummary } from './submit-view.js';

type Draft = Parameters<typeof completeness>[0];

const draft = (over: Partial<Draft> = {}): Draft =>
  ({
    id: 'd',
    ownerId: 'o',
    version: 1,
    step: 5,
    adStyle: 'ugc',
    intakeMode: 'description',
    productName: ' Calm Cap ',
    productDescription: 'A slow morning drink',
    audienceAgeMin: 25,
    audienceAgeMax: 40,
    audienceGender: null,
    audienceInterests: null,
    directionGoal: 'awareness',
    directionTone: null,
    segmentCount: 2,
    concept: 'A slow morning',
    script: null,
    productMediaId: null,
    campaignId: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as Draft;

describe('completeness of a draft at submit', () => {
  it('accepts a complete draft and trims the name', () => {
    const { fields, missing } = completeness(draft(), null);
    expect(missing).toEqual([]);
    expect(fields).toEqual({ productName: 'Calm Cap', productDescription: 'A slow morning drink', segmentCount: 2 });
  });

  it('takes the description of a completed analysis when none was typed', () => {
    expect(completeness(draft({ productDescription: '  ' }), 'A bottle.').fields?.productDescription).toBe('A bottle.');
    expect(completeness(draft({ productDescription: null }), null).missing.map((m) => m.field)).toEqual(['productDescription']);
  });

  it('lists every missing field, each with the code required', () => {
    const { fields, missing } = completeness(
      draft({ productName: null, audienceAgeMin: null, audienceAgeMax: null, directionGoal: null, segmentCount: null, concept: ' ' }),
      null,
    );
    expect(fields).toBeUndefined();
    expect(missing.map((m) => m.field)).toEqual(['productName', 'audience.ageMin', 'audience.ageMax', 'direction.goal', 'direction.segmentCount', 'concept']);
    expect(missing.every((m) => m.code === 'required')).toBe(true);
  });

  it('asks for the script in script mode, and not for the concept', () => {
    expect(completeness(draft({ intakeMode: 'script', script: null, concept: 'x' }), null).missing.map((m) => m.field)).toEqual(['script']);
    expect(completeness(draft({ intakeMode: 'script', script: 'Hello', concept: null }), null).missing).toEqual([]);
  });
});

describe('reuse hash', () => {
  it('is 64 hex characters, stable, and differs by kind, subject and generation', () => {
    const base = reuseHashOf('brief_generation', 'c1', 1);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(reuseHashOf('brief_generation', 'c1', 1)).toBe(base);
    expect(reuseHashOf('brief_generation', 'c1', 2)).not.toBe(base);
    expect(reuseHashOf('brief_generation', 'c2', 1)).not.toBe(base);
    expect(reuseHashOf('image_analysis', 'c1', 1)).not.toBe(base);
  });
});

describe('job summary', () => {
  it('keeps microseconds, labels the state and carries `reused`', () => {
    const row = {
      id: 'j',
      state: 'submitting',
      causeClass: null,
      causeMessage: null,
      createdAt: '2026-11-15 23:53:22.123456+00',
      updatedAt: '2026-11-15 23:53:22+00',
      deadlineAt: '2026-11-16 00:03:22.5+00',
    };
    expect(jobSummary(row, true)).toMatchObject({ label: 'queued', reused: true, createdAt: '2026-11-15T23:53:22.123456Z', deadlineAt: '2026-11-16T00:03:22.5Z' });
    expect(jobSummary({ ...row, state: 'cancelled' }, false).label).toBe('failed');
    expect(jobSummary({ ...row, state: 'weird' }, false).label).toBe('pending');
    expect(instant('2026-11-15T23:53:22Z')).toBe('2026-11-15T23:53:22.000Z');
  });
});
