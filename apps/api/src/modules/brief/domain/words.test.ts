import { describe, expect, it } from 'vitest';
import { EM_DASH, HARD_MAX_WORDS, countWords, removeDashes, shortenDialogue } from './words.js';

const CTA = 'Take the free 2-minute quiz';
/** n words in sentences of five words each, ending with a full stop. */
const words = (n: number): string => {
  const out: string[] = [];
  for (let i = 1; i <= n; i += 1) out.push(i % 5 === 0 || i === n ? `word${String(i)}.` : `word${String(i)}`);
  return out.join(' ');
};

describe('countWords', () => {
  it('counts tokens with a letter or digit, so hyphenated words, numbers and dashes behave', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('Take the free 2-minute quiz')).toBe(5);
    expect(countWords('calm — steady - quiet – slow')).toBe(4);
    expect(countWords("it's 21+ only")).toBe(3);
    expect(countWords('line one\nline two\tend')).toBe(5);
    expect(countWords('...  !!!')).toBe(0);
  });

  it('counts the TC-BRF-03 sizes exactly', () => {
    for (const n of [29, 30, 31, 32, 42, 43, 45, 46, 50]) expect(countWords(words(n))).toBe(n);
  });
});

describe('removeDashes (TC-BRF-04)', () => {
  it('replaces em dashes, en dashes and spaced hyphens with a comma break', () => {
    expect(removeDashes('Calm days—quiet nights')).toBe('Calm days, quiet nights');
    expect(removeDashes('Calm days — quiet nights')).toBe('Calm days, quiet nights');
    expect(removeDashes('Calm days – quiet nights')).toBe('Calm days, quiet nights');
    expect(removeDashes('Calm days - quiet nights')).toBe('Calm days, quiet nights');
  });

  it('keeps a numeric range and an inner hyphen, and leaves no stray comma', () => {
    expect(removeDashes('Open 2–3 days')).toBe('Open 2-3 days');
    expect(removeDashes('a free 2-minute quiz')).toBe('a free 2-minute quiz');
    expect(removeDashes('Wait — . Done')).toBe('Wait. Done');
    expect(removeDashes('Wait —— again')).toBe('Wait, again');
    expect(removeDashes('— Start here')).toBe('Start here');
    expect(removeDashes('Ends here —')).toBe('Ends here');
    expect(removeDashes('a — — b')).toBe('a, b');
  });

  it('is idempotent and leaves no em dash', () => {
    const once = removeDashes('One — two – three - four');
    expect(removeDashes(once)).toBe(once);
    expect(EM_DASH.test(once)).toBe(false);
  });
});

describe('shortenDialogue (TC-BRF-03)', () => {
  it('returns text that already fits unchanged', () => {
    for (const n of [30, 42, 43, 45]) expect(shortenDialogue(words(n))).toEqual({ text: words(n), trimmed: false });
  });

  it('cuts 46 and 50 words to at most 45, at the last sentence boundary that fits', () => {
    for (const n of [46, 50]) {
      const result = shortenDialogue(words(n));
      expect(result.trimmed).toBe(true);
      expect(countWords(result.text)).toBeLessThanOrEqual(HARD_MAX_WORDS);
      expect(result.text.endsWith('.')).toBe(true);
      expect(countWords(result.text)).toBe(45);
    }
  });

  it('cuts at the word limit when the first sentence alone is too long, and ends it with a full stop', () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${String(i)}`).join(' ');
    const result = shortenDialogue(long);
    expect(countWords(result.text)).toBe(45);
    expect(result.text.endsWith('.')).toBe(true);
    const commas = `${Array.from({ length: 44 }, (_, i) => `w${String(i)}`).join(' ')}, ${Array.from({ length: 10 }, (_, i) => `x${String(i)}`).join(' ')}`;
    expect(shortenDialogue(commas).text.endsWith('x0.')).toBe(true);
    expect(shortenDialogue(`${long}!`, { max: 3 }).text).toBe('w0 w1 w2.');
  });

  it('keeps a closing call to action whole and cuts only the text before it', () => {
    const text = `${words(48)} ${CTA}.`;
    const result = shortenDialogue(text, { keepSuffix: CTA });
    expect(countWords(result.text)).toBeLessThanOrEqual(45);
    expect(result.text.endsWith(`${CTA}.`)).toBe(true);
    expect(result.trimmed).toBe(true);
  });

  it('falls back to a plain cut when the suffix is absent, empty or as long as the limit', () => {
    expect(countWords(shortenDialogue(words(50), { keepSuffix: CTA }).text)).toBe(45);
    expect(countWords(shortenDialogue(words(50), { keepSuffix: '' }).text)).toBe(45);
    expect(countWords(shortenDialogue(words(50), { keepSuffix: 'a b c', max: 3 }).text)).toBeLessThanOrEqual(3);
  });

  it('returns only the call to action when nothing before it fits', () => {
    const text = `${words(10)} ${CTA}.`;
    expect(shortenDialogue(text, { max: 5, keepSuffix: CTA }).text).toBe(`${CTA}.`);
    expect(shortenDialogue(`${words(10)} a b c.`, { max: 3, keepSuffix: 'a b c' }).text).toBe('a b c.');
  });

  it('honours another maximum and an empty text', () => {
    expect(countWords(shortenDialogue(words(20), { max: 10 }).text)).toBe(10);
    expect(shortenDialogue('')).toEqual({ text: '', trimmed: false });
    expect(shortenDialogue(words(20), { max: 0 }).text).toBe('');
  });
});
