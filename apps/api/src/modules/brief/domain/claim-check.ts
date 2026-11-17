import type { BrandRule, ClaimField, RuleClass } from './brand-rules.js';
import { CLAIM_FIELDS } from './brand-rules.js';
import { EM_DASH, countWords } from './words.js';

/** The pure claim-check engine (REQ-007, REQ-008; ARCHITECTURE §5.3). No IO: rules in, findings out. */

/** The rule id of the issue raised when generation had to trim a segment (not a text rule). */
export const WORD_COUNT_TRIMMED_RULE_ID = 'word_count_trimmed';
export const WORD_COUNT_TRIMMED_MESSAGE =
  'The dialogue was trimmed to the 45 word maximum. Read it again.';

export interface SegmentText {
  readonly dialogue: string;
  readonly prompt: string;
  /** The last active segment carries the call to action and the 21+ framing. */
  readonly isLast: boolean;
}

export interface Finding {
  readonly ruleId: string;
  readonly class: RuleClass;
  readonly field: ClaimField;
  readonly message: string;
  /** Character offsets into the field's text; null for a finding about the text as a whole. */
  readonly spanStart: number | null;
  readonly spanEnd: number | null;
}

export interface BriefSegmentText {
  readonly position: number;
  readonly dialogue: string;
  readonly prompt: string;
}

export interface PositionedFinding extends Finding {
  readonly position: number;
}

type Matcher = (
  text: string,
  segment: SegmentText,
) => { start: number; end: number } | 'whole' | null;

interface CompiledRule {
  readonly rule: BrandRule;
  readonly fields: readonly ClaimField[];
  readonly lastOnly: boolean;
  readonly match: Matcher;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';

function firstMatch(source: string): Matcher {
  const regex = new RegExp(source, 'iu');
  return (text) => {
    const found = regex.exec(text);
    return found === null ? null : { start: found.index, end: found.index + found[0].length };
  };
}

function compileOne(rule: BrandRule): CompiledRule {
  const params = rule.params;
  const fields = (params['fields'] as ClaimField[] | undefined) ?? CLAIM_FIELDS;
  switch (rule.kind) {
    case 'phrase': {
      const alternatives = (params['phrases'] as string[]).map(escape).join('|');
      return {
        rule,
        fields,
        lastOnly: false,
        match: firstMatch(`${BOUNDARY_BEFORE}(?:${alternatives})${BOUNDARY_AFTER}`),
      };
    }
    case 'regex':
      return { rule, fields, lastOnly: false, match: firstMatch(params['pattern'] as string) };
    case 'word_count_min': {
      const min = params['min'] as number;
      return {
        rule,
        fields: ['dialogue'],
        lastOnly: false,
        match: (text) => (countWords(text) < min ? 'whole' : null),
      };
    }
    case 'word_count_max_target': {
      const target = params['target'] as number;
      return {
        rule,
        fields: ['dialogue'],
        lastOnly: false,
        match: (text) => (countWords(text) > target ? 'whole' : null),
      };
    }
    case 'cta_exact': {
      const text = params['text'] as string;
      return {
        rule,
        fields: ['dialogue'],
        lastOnly: true,
        match: (dialogue) => (dialogue.includes(text) ? null : 'whole'),
      };
    }
    case 'em_dash':
      return { rule, fields, lastOnly: false, match: firstMatch(EM_DASH.source) };
    case 'age_framing': {
      const patterns = (params['patterns'] as string[]).map((source) => new RegExp(source, 'iu'));
      return {
        rule,
        fields: ['dialogue'],
        lastOnly: true,
        // Framing in the prompt counts too: it is what the video is generated from.
        match: (_text, segment) =>
          patterns.some((pattern) => pattern.test(segment.dialogue) || pattern.test(segment.prompt))
            ? null
            : 'whole',
      };
    }
  }
}

/** The active rules, ready to run. Compile once and reuse. */
export function compileRules(rules: readonly BrandRule[]): CompiledRule[] {
  return rules.filter((rule) => rule.active).map(compileOne);
}

export type CompiledRules = ReturnType<typeof compileRules>;

/** Runs every rule on one segment: at most one finding per rule and field, at the first offending span. */
export function checkSegment(rules: CompiledRules, segment: SegmentText): Finding[] {
  const findings: Finding[] = [];
  for (const compiled of rules) {
    if (compiled.lastOnly && !segment.isLast) continue;
    for (const field of compiled.fields) {
      const found = compiled.match(segment[field], segment);
      if (found === null) continue;
      const span =
        found === 'whole' ? { start: null, end: null } : { start: found.start, end: found.end };
      findings.push({
        ruleId: compiled.rule.id,
        class: compiled.rule.class,
        field,
        message: compiled.rule.message,
        spanStart: span.start,
        spanEnd: span.end,
      });
    }
  }
  return findings;
}

/** Runs the rules over a brief's active segments; the one with the highest position is the last. */
export function checkBrief(
  rules: CompiledRules,
  segments: readonly BriefSegmentText[],
): PositionedFinding[] {
  const lastPosition = Math.max(0, ...segments.map((segment) => segment.position));
  return segments.flatMap((segment) =>
    checkSegment(rules, {
      dialogue: segment.dialogue,
      prompt: segment.prompt,
      isLast: segment.position === lastPosition,
    }).map((finding) => ({ ...finding, position: segment.position })),
  );
}
