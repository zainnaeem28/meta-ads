import { describe, expect, it } from 'vitest';
import { judge, mismatchSummary, normalizeWords, numberWords, wordErrorRate } from './qc-wer.js';

describe('normalizeWords', () => {
  it('lower-cases, strips punctuation and writes numbers as words', () => {
    expect(normalizeWords('Hello, World! It\'s 42 days; 1,250 people.')).toEqual(['hello', 'world', 'its', 'forty', 'two', 'days', 'one', 'thousand', 'two', 'hundred', 'fifty', 'people']);
  });

  it('says a decimal and a percentage', () => {
    expect(normalizeWords('3.5 and 20%')).toEqual(['three', 'point', 'five', 'and', 'twenty', 'percent']);
  });

  it('splits digits out of a mixed token and drops empty text', () => {
    expect(normalizeWords('b12')).toEqual(['b', 'twelve']);
    expect(normalizeWords('  ...  ')).toEqual([]);
  });
});

describe('numberWords', () => {
  it.each([
    ['0', 'zero'],
    ['7', 'seven'],
    ['15', 'fifteen'],
    ['100', 'one hundred'],
    ['101', 'one hundred one'],
    ['2024', 'two thousand twenty four'],
    ['1000000', 'one million'],
  ])('%s is %s', (digits, words) => {
    expect(numberWords(digits).join(' ')).toBe(words);
  });

  it('keeps a number too large to say digit by digit', () => {
    expect(numberWords('12345678901').join(' ')).toBe('one two three four five six seven eight nine zero one');
  });
});

describe('wordErrorRate', () => {
  it('is zero for the same words', () => {
    expect(wordErrorRate(['a', 'b'], ['a', 'b'])).toEqual({ rate: 0, missing: [], extra: [] });
  });

  it('counts a substitution, a deletion and an insertion over the reference length', () => {
    const result = wordErrorRate(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'e', 'd']);
    expect(result.rate).toBe(0.5);
    expect(result.missing).toEqual(['b']);
    expect(result.extra).toEqual(['x', 'e']);
  });

  it('is capped at 1 and handles an empty side', () => {
    expect(wordErrorRate(['a'], ['x', 'y', 'z']).rate).toBe(1);
    expect(wordErrorRate([], [])).toMatchObject({ rate: 0 });
    expect(wordErrorRate([], ['x'])).toMatchObject({ rate: 1, extra: ['x'] });
    expect(wordErrorRate(['a', 'b'], [])).toMatchObject({ rate: 1, missing: ['a', 'b'] });
  });
});

describe('judge', () => {
  const dialogue = 'A calm start to the day, with 2 cups of tea.';

  it('passes at the limit (WER <= max) and has no reason', () => {
    const verdict = judge(dialogue, 'A calm start to the day with two cups of tea', 0.2);
    expect(verdict).toEqual({ passed: true, rate: 0, reason: null });
    const edge = judge('one two three four five', 'one two three four six', 0.2);
    expect(edge).toMatchObject({ passed: true, rate: 0.2, reason: null });
  });

  it('fails over the limit with a summary of the missing and extra words, never the transcript', () => {
    const verdict = judge('one two three four five', 'one two canary-secret-words five', 0.2);
    expect(verdict.passed).toBe(false);
    expect(verdict.rate).toBe(0.6);
    expect(verdict.reason).toBe('60% of the words differ from the script. Missing: three, four. Extra: canary, secret, words.');
  });
});

describe('mismatchSummary', () => {
  it('lists at most twelve words a side and fits the column', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${String(i)}`);
    const text = mismatchSummary({ rate: 1, missing: words, extra: words });
    expect(text).toContain('and 28 more');
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it('is cut to 300 characters', () => {
    const long = Array.from({ length: 12 }, () => 'x'.repeat(40));
    expect(mismatchSummary({ rate: 1, missing: long, extra: long }).length).toBe(300);
  });
});
