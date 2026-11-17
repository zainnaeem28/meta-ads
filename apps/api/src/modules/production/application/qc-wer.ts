// Word error rate of a clip's spoken words against the segment's dialogue (ARCHITECTURE §5.6). Pure: no I/O, no logging.

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const MAX_NUMBER = 999_999_999;
/** Words listed per side in a mismatch summary, and the column's length. */
const LISTED_WORDS = 12;
const REASON_MAX = 300;

function below1000(n: number): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) words.push(ONES[hundreds] as string, 'hundred');
  if (rest >= 20) {
    words.push(TENS[Math.floor(rest / 10)] as string);
    if (rest % 10 > 0) words.push(ONES[rest % 10] as string);
  } else if (rest > 0 || hundreds === 0) {
    words.push(ONES[rest] as string);
  }
  return words;
}

/** A whole number as English words ("42" is "forty two"); a number too large to say stays digit by digit. */
export function numberWords(digits: string): string[] {
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n > MAX_NUMBER)
    return [...digits].map((digit) => ONES[Number(digit)] as string);
  if (n === 0) return ['zero'];
  const words: string[] = [];
  for (const [size, name] of [
    [1_000_000, 'million'],
    [1000, 'thousand'],
    [1, ''],
  ] as const) {
    const part = Math.floor(n / size) % 1000;
    if (part === 0) continue;
    words.push(...below1000(part));
    if (name !== '') words.push(name);
  }
  return words;
}

/** Lower case, punctuation stripped, numbers as words, split on white space. */
export function normalizeWords(text: string): string[] {
  const spaced = text
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/['’]/g, '')
    .replace(/(\d+)\.(\d+)/g, '$1 point $2')
    .replace(/%/g, ' percent ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const words: string[] = [];
  for (const token of spaced.split(' ')) {
    if (token === '') continue;
    if (/^\d+$/.test(token)) words.push(...numberWords(token));
    else if (/\d/.test(token))
      words.push(
        ...token
          .split(/(\d+)/)
          .flatMap((part) => (/^\d+$/.test(part) ? numberWords(part) : part === '' ? [] : [part])),
      );
    else words.push(token);
  }
  return words;
}

export interface WerResult {
  /** Edits over the reference length, 0 to 1 (more edits than reference words count as 1). */
  readonly rate: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/** Word-level edit distance with a trace of what was left out and what was added. */
export function wordErrorRate(reference: readonly string[], heard: readonly string[]): WerResult {
  const rows = reference.length + 1;
  const cols = heard.length + 1;
  const cost: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) (cost[i] as number[])[0] = i;
  for (let j = 0; j < cols; j += 1) (cost[0] as number[])[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = reference[i - 1] === heard[j - 1] ? 0 : 1;
      (cost[i] as number[])[j] = Math.min(
        ((cost[i - 1] as number[])[j - 1] as number) + same,
        ((cost[i - 1] as number[])[j] as number) + 1,
        ((cost[i] as number[])[j - 1] as number) + 1,
      );
    }
  }
  const missing: string[] = [];
  const extra: string[] = [];
  let i = reference.length;
  let j = heard.length;
  while (i > 0 || j > 0) {
    const here = (cost[i] as number[])[j] as number;
    if (
      i > 0 &&
      j > 0 &&
      here ===
        ((cost[i - 1] as number[])[j - 1] as number) + (reference[i - 1] === heard[j - 1] ? 0 : 1)
    ) {
      if (reference[i - 1] !== heard[j - 1]) {
        missing.push(reference[i - 1] as string);
        extra.push(heard[j - 1] as string);
      }
      i -= 1;
      j -= 1;
    } else if (i > 0 && here === ((cost[i - 1] as number[])[j] as number) + 1) {
      missing.push(reference[i - 1] as string);
      i -= 1;
    } else {
      extra.push(heard[j - 1] as string);
      j -= 1;
    }
  }
  const edits = (cost[reference.length] as number[])[heard.length] as number;
  const rate =
    reference.length === 0 ? (heard.length === 0 ? 0 : 1) : Math.min(1, edits / reference.length);
  return { rate, missing: missing.reverse(), extra: extra.reverse() };
}

/** The user-facing summary of a failed check: a few missing and extra words, never the transcript. */
export function mismatchSummary(result: WerResult): string {
  const list = (words: readonly string[]): string => {
    const shown = words.slice(0, LISTED_WORDS).join(', ');
    return words.length > LISTED_WORDS
      ? `${shown} and ${String(words.length - LISTED_WORDS)} more`
      : shown;
  };
  const parts = [`${String(Math.round(result.rate * 100))}% of the words differ from the script.`];
  if (result.missing.length > 0) parts.push(`Missing: ${list(result.missing)}.`);
  if (result.extra.length > 0) parts.push(`Extra: ${list(result.extra)}.`);
  const text = parts.join(' ');
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}…`;
}

/** The outcome of a comparison at `maxRate` (`WER <= QC_MAX_WORD_ERROR_RATE` passes). */
export function judge(
  dialogue: string,
  heard: string,
  maxRate: number,
): { passed: boolean; rate: number; reason: string | null } {
  const result = wordErrorRate(normalizeWords(dialogue), normalizeWords(heard));
  const rate = Math.round(result.rate * 1000) / 1000;
  const passed = result.rate <= maxRate;
  return { passed, rate, reason: passed ? null : mismatchSummary(result) };
}
