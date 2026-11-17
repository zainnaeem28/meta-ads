import { HARD_MAX_WORDS, countWords, removeDashes, shortenDialogue } from '../../domain/words.js';
import type { DraftSegment } from './text-ai.port.js';

/** Deterministic post-processing of what the provider returned (ARCHITECTURE §5.3, §5.4). Pure: no IO. */

/** The exact call to action the last segment carries (BR-05; `other_cta_exact` in `config/brand-rules.json`). */
export const CALL_TO_ACTION = 'Take the free 2-minute quiz';

/** Dashes removed (not flagged) and the call to action put in when the last segment lacks it. */
export function finalizeDialogue(dialogue: string, isLast: boolean): string {
  const clean = removeDashes(dialogue);
  if (!isLast || clean.includes(CALL_TO_ACTION)) return clean;
  const body = clean.replace(/[\s.!?,;:]+$/u, '');
  return body === '' ? `${CALL_TO_ACTION}.` : `${body}. ${CALL_TO_ACTION}.`;
}

export function finalizeSegment(segment: DraftSegment, isLast: boolean): DraftSegment {
  return {
    position: segment.position,
    dialogue: finalizeDialogue(segment.dialogue, isLast),
    prompt: removeDashes(segment.prompt),
  };
}

export const tooLong = (segment: DraftSegment): boolean =>
  countWords(segment.dialogue) > HARD_MAX_WORDS;

/** The last resort when the second call did not bring a segment under the limit: trim, and say which were trimmed. */
export function trimOverLong(
  segments: readonly DraftSegment[],
  lastPosition: number,
): { segments: DraftSegment[]; trimmed: number[] } {
  const trimmed: number[] = [];
  const out = segments.map((segment) => {
    if (!tooLong(segment)) return segment;
    const result = shortenDialogue(segment.dialogue, {
      max: HARD_MAX_WORDS,
      ...(segment.position === lastPosition ? { keepSuffix: CALL_TO_ACTION } : {}),
    });
    if (result.trimmed) trimmed.push(segment.position);
    return { ...segment, dialogue: result.text };
  });
  return { segments: out, trimmed };
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Drops every sentence that mentions a sensitive term (ethnicity, race, age, health, body, medical: the word list of
 * `config/brand-rules.json`). A term matches as a whole word or phrase, any case. What is left is the description.
 */
export function dropSensitiveSentences(text: string, terms: readonly string[]): string {
  const matchers = terms.map(
    (term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term.trim())}(?![\\p{L}\\p{N}])`, 'iu'),
  );
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/gu) ?? [];
  return sentences
    .filter((sentence) => !matchers.some((matcher) => matcher.test(sentence)))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}
