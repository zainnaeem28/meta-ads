/** Word counting, dash clean-up and shortening of segment dialogue (REQ-007; ARCHITECTURE §5.3). Pure: no IO. */

/** A word is a whitespace-separated token with a letter or digit in it; a lone dash or mark is not a word. */
const WORD = /[\p{L}\p{N}]/u;

export function countWords(text: string): number {
  let count = 0;
  for (const token of text.split(/\s+/u)) if (WORD.test(token)) count += 1;
  return count;
}

/** Em dash (and horizontal bar), en dash and a spaced hyphen: the characters public copy must not carry (BR-09). */
export const EM_DASH = /[—―]/u;
const SPOKEN_DASH = /\s*[—―]\s*|\s*–\s*|\s+-\s+/gu;

/**
 * Replaces em dashes, en dashes and spaced hyphens with a comma break; a numeric range such as `2–3` keeps a plain
 * hyphen. Idempotent.
 */
export function removeDashes(text: string): string {
  return text
    .replace(/(\d)\s*–\s*(\d)/gu, '$1-$2')
    .replace(SPOKEN_DASH, ', ')
    .replace(/,(?:\s*,)+/gu, ',')
    .replace(/,\s*([.!?;:])/gu, '$1')
    .replace(/^\s*,\s*/u, '')
    .replace(/,\s*$/u, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

export interface ShortenResult {
  readonly text: string;
  /** True when words were removed. */
  readonly trimmed: boolean;
}

export interface ShortenOptions {
  /** The hard maximum, 45 words (REQ-007). */
  readonly max?: number;
  /** A closing phrase (the call to action) that stays whole when the text ends with it. */
  readonly keepSuffix?: string;
}

export const HARD_MAX_WORDS = 45;

const SENTENCE = /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/gu;

function cutWords(text: string, budget: number): string {
  const kept = text.trim().split(/\s+/u).slice(0, Math.max(budget, 0)).join(' ');
  const bare = kept.replace(/[,;:\s]+$/u, '');
  return /[.!?]$/u.test(bare) || bare === '' ? bare : `${bare}.`;
}

function trimBody(body: string, budget: number): string {
  let kept = '';
  let used = 0;
  for (const sentence of body.match(SENTENCE) ?? []) {
    const words = countWords(sentence);
    if (used + words > budget) break;
    kept += sentence;
    used += words;
  }
  return kept.trim() === '' ? cutWords(body, budget) : kept.trim();
}

/**
 * Brings dialogue to at most `max` words: trims at the last sentence boundary that fits, or at `max` words when the
 * first sentence alone is too long. A `keepSuffix` the text ends with is kept whole and only the part before it is cut.
 * Text that already fits is returned unchanged.
 */
export function shortenDialogue(text: string, options: ShortenOptions = {}): ShortenResult {
  const max = options.max ?? HARD_MAX_WORDS;
  if (countWords(text) <= max) return { text, trimmed: false };
  const suffix = options.keepSuffix;
  const at = suffix === undefined || suffix === '' ? -1 : text.lastIndexOf(suffix);
  if (suffix !== undefined && at >= 0 && countWords(suffix) <= max) {
    const tail = text.slice(at).trim();
    const body = trimBody(text.slice(0, at), max - countWords(tail));
    return { text: body === '' ? tail : `${body} ${tail}`, trimmed: true };
  }
  return { text: trimBody(text, max), trimmed: true };
}
