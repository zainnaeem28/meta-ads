import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countWords } from '../../domain/words.js';
import {
  CALL_TO_ACTION,
  dropSensitiveSentences,
  finalizeDialogue,
  finalizeSegment,
  tooLong,
  trimOverLong,
} from './post-process.js';

const rulesFile = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'config',
      'brand-rules.json',
    ),
    'utf8',
  ),
) as {
  sensitiveAttributeFilter: { terms: string[] };
};
const TERMS = rulesFile.sensitiveAttributeFilter.terms;

describe('finalizeDialogue (TC-BRF-03, TC-BRF-04)', () => {
  it('removes em dashes and puts the exact call to action in the last segment', () => {
    const out = finalizeDialogue('I tried it for a week — it fit my mornings', true);
    expect(out).not.toMatch(/[—–]/u);
    expect(out.endsWith(`${CALL_TO_ACTION}.`)).toBe(true);
  });

  it('keeps a call to action that is already there and leaves other segments without one', () => {
    const text = `Slow mornings. ${CALL_TO_ACTION}.`;
    expect(finalizeDialogue(text, true)).toBe(text);
    expect(finalizeDialogue('Slow mornings.', false)).toBe('Slow mornings.');
  });

  it('handles an empty last segment', () => {
    expect(finalizeDialogue('', true)).toBe(`${CALL_TO_ACTION}.`);
  });

  it('cleans the prompt of dashes too', () => {
    expect(
      finalizeSegment({ position: 1, dialogue: 'Hi.', prompt: 'A kitchen — warm light' }, false)
        .prompt,
    ).toBe('A kitchen, warm light');
  });
});

describe('over-long dialogue', () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${String(i)}`).join(' ');

  it('flags a segment over 45 words and trims it at the limit, keeping the call to action whole', () => {
    expect(tooLong({ position: 1, dialogue: long, prompt: 'p' })).toBe(true);
    const last = finalizeSegment(
      { position: 2, dialogue: `${long}. ${CALL_TO_ACTION}.`, prompt: 'p' },
      true,
    );
    const result = trimOverLong([{ position: 1, dialogue: long, prompt: 'p' }, last], 2);
    expect(result.trimmed).toEqual([1, 2]);
    expect(result.segments.every((segment) => countWords(segment.dialogue) <= 45)).toBe(true);
    expect(result.segments[1]?.dialogue).toContain(CALL_TO_ACTION);
  });

  it('leaves a segment that fits alone', () => {
    const fine = { position: 1, dialogue: 'Short and calm.', prompt: 'p' };
    expect(trimOverLong([fine], 1)).toEqual({ segments: [fine], trimmed: [] });
  });
});

describe('dropSensitiveSentences (TC-UPL analysis, REQ-006)', () => {
  it('drops the sentences that infer ethnicity, age or health from a person in the photo and keeps the product', () => {
    const description =
      'A small amber glass bottle with a silver cap and a minimalist label. A young woman of Asian descent holds it. ' +
      'She looks healthy and about 25 years old. The box is matte green.';
    expect(dropSensitiveSentences(description, TERMS)).toBe(
      'A small amber glass bottle with a silver cap and a minimalist label. The box is matte green.',
    );
  });

  it('matches whole words only, any case, and returns an empty string when nothing is left', () => {
    expect(dropSensitiveSentences('Wheat-free blend in a Tin.', TERMS)).toBe(
      'Wheat-free blend in a Tin.',
    );
    expect(dropSensitiveSentences('ELDERLY patient holding the jar.', TERMS)).toBe('');
  });
});
