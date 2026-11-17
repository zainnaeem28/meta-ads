import { describe, expect, it } from 'vitest';
import {
  deriveProgress,
  isNonTerminal,
  isOutOfDate,
  isRetryable,
  labelOf,
  videoReuseHash,
} from './video-job.js';

const options = { durationSeconds: 15, resolution: '1080p', aspectRatio: '9:16' };
const base = { segmentId: 's1', prompt: 'p', dialogue: 'd', referenceMediaId: null, options };

describe('videoReuseHash', () => {
  it('is 64 hex characters and stable', () => {
    expect(videoReuseHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(videoReuseHash(base)).toBe(videoReuseHash({ ...base }));
  });
  it('changes with any part of the work', () => {
    const hash = videoReuseHash(base);
    expect(videoReuseHash({ ...base, segmentId: 's2' })).not.toBe(hash);
    expect(videoReuseHash({ ...base, prompt: 'p2' })).not.toBe(hash);
    expect(videoReuseHash({ ...base, dialogue: 'd2' })).not.toBe(hash);
    expect(videoReuseHash({ ...base, referenceMediaId: 'm' })).not.toBe(hash);
    expect(videoReuseHash({ ...base, options: { ...options, resolution: '720p' } })).not.toBe(hash);
  });
  it('keeps neighbouring fields apart', () => {
    expect(videoReuseHash({ ...base, prompt: 'ab', dialogue: 'c' })).not.toBe(
      videoReuseHash({ ...base, prompt: 'a', dialogue: 'bc' }),
    );
  });
});

describe('states', () => {
  it('derives out of date from the revision', () => {
    expect(isOutOfDate(1, 2)).toBe(true);
    expect(isOutOfDate(2, 2)).toBe(false);
  });
  it('knows retryable and non-terminal states', () => {
    expect(isRetryable('failed')).toBe(true);
    expect(isRetryable('cancelled')).toBe(true);
    expect(isRetryable('completed')).toBe(false);
    expect(isNonTerminal('pending')).toBe(true);
    expect(isNonTerminal('completed')).toBe(false);
  });
  it('maps states to the five labels', () => {
    expect(
      [
        'pending',
        'submitting',
        'submitted',
        'processing',
        'completed',
        'failed',
        'cancelled',
        'x',
      ].map(labelOf),
    ).toEqual([
      'pending',
      'created',
      'created',
      'processing',
      'completed',
      'failed',
      'failed',
      'pending',
    ]);
  });
});

describe('deriveProgress', () => {
  const facts = {
    anyNonTerminal: false,
    briefFailed: false,
    latestVideoStates: [],
    assemblyDone: false,
    latestAssemblyFailed: false,
  };
  it('is processing while anything runs', () => {
    expect(deriveProgress({ ...facts, anyNonTerminal: true, briefFailed: true })).toBe(
      'processing',
    );
  });
  it('is failed for a failed brief, assembly or latest clip', () => {
    expect(deriveProgress({ ...facts, briefFailed: true })).toBe('failed');
    expect(deriveProgress({ ...facts, latestAssemblyFailed: true })).toBe('failed');
    expect(deriveProgress({ ...facts, latestVideoStates: ['completed', 'cancelled'] })).toBe(
      'failed',
    );
  });
  it('is completed with a done assembly and otherwise in progress', () => {
    expect(deriveProgress({ ...facts, assemblyDone: true, latestVideoStates: ['completed'] })).toBe(
      'completed',
    );
    expect(deriveProgress({ ...facts, latestVideoStates: ['completed'] })).toBe('in_progress');
  });
});
