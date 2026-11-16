import { z } from 'zod';

/** `config/brand-rules.json` (SB-D10): versioned, changed by a reviewed PR, loaded into `brand_rules` by the release seed. */

export const RULE_CLASSES = ['high_risk', 'other'] as const;
export type RuleClass = (typeof RULE_CLASSES)[number];

export const RULE_KINDS = [
  'phrase',
  'regex',
  'word_count_min',
  'word_count_max_target',
  'cta_exact',
  'em_dash',
  'age_framing',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const CLAIM_FIELDS = ['dialogue', 'prompt'] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];

const fields = z.array(z.enum(CLAIM_FIELDS)).min(1).max(2).optional();
/** A pattern is bounded and may not nest an unbounded quantifier inside a quantified group (catastrophic backtracking). */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/u;
const pattern = z
  .string()
  .min(1)
  .max(1200)
  .superRefine((source, context) => {
    if (NESTED_QUANTIFIER.test(source)) {
      context.addIssue({ code: 'custom', message: 'nested quantifier' });
      return;
    }
    try {
      new RegExp(source, 'giu');
    } catch {
      context.addIssue({ code: 'custom', message: 'not a valid regular expression' });
    }
  });

const phraseParams = z.object({ phrases: z.array(z.string().min(1).max(80)).min(1).max(100), fields }).strict();
const regexParams = z.object({ pattern, fields }).strict();
const minParams = z.object({ min: z.number().int().min(1).max(120) }).strict();
const maxParams = z
  .object({ target: z.number().int().min(1).max(120), hardMax: z.number().int().min(1).max(120) })
  .strict()
  .refine((params) => params.hardMax >= params.target, { message: 'hardMax must not be below target' });
const ctaParams = z.object({ text: z.string().min(1).max(120) }).strict();
const emDashParams = z.object({}).strict();
const ageParams = z.object({ patterns: z.array(pattern).min(1).max(20) }).strict();

const PARAMS: Readonly<Record<RuleKind, z.ZodType>> = {
  phrase: phraseParams,
  regex: regexParams,
  word_count_min: minParams,
  word_count_max_target: maxParams,
  cta_exact: ctaParams,
  em_dash: emDashParams,
  age_framing: ageParams,
};

const ruleShape = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    class: z.enum(RULE_CLASSES),
    clearable: z.boolean(),
    kind: z.enum(RULE_KINDS),
    params: z.record(z.string(), z.unknown()),
    message: z.string().min(1).max(300),
    active: z.boolean(),
  })
  .strict()
  // brand_rules_clearable_ck: a high-risk rule is never clearable, and an other-class rule always is (REQ-008).
  .refine((rule) => rule.clearable === (rule.class === 'other'), {
    message: 'high_risk rules are not clearable and other rules are',
    path: ['clearable'],
  })
  .superRefine((rule, context) => {
    const parsed = PARAMS[rule.kind].safeParse(rule.params);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', message: issue.message, path: ['params', ...issue.path] });
      }
    }
  });

const fileShape = z
  .object({
    version: z.literal(1),
    rulesVersion: z.number().int().min(1),
    note: z.string().optional(),
    rules: z.array(ruleShape).min(1),
    sensitiveAttributeFilter: z.object({ terms: z.array(z.string().min(1).max(40)).min(1).max(500) }).strict(),
  })
  .strict();

export interface BrandRule {
  readonly id: string;
  readonly class: RuleClass;
  readonly clearable: boolean;
  readonly kind: RuleKind;
  readonly params: Readonly<Record<string, unknown>>;
  readonly message: string;
  readonly rulesVersion: number;
  readonly active: boolean;
}

export interface BrandRuleSet {
  readonly rulesVersion: number;
  readonly rules: readonly BrandRule[];
  /** Words the image-analysis filter drops sentences for (ARCHITECTURE §5.4); not stored in `brand_rules`. */
  readonly sensitiveTerms: readonly string[];
}

export class BrandRulesInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`brand rules are invalid: ${issues.join('; ')}`);
    this.name = 'BrandRulesInvalidError';
  }
}

const describe = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`);

/** Parses and checks the file's content: shape, per-kind parameters, clearable rule and unique ids. */
export function parseBrandRules(content: unknown): BrandRuleSet {
  const parsed = fileShape.safeParse(content);
  if (!parsed.success) throw new BrandRulesInvalidError(describe(parsed.error));
  const ids = new Set<string>();
  const duplicates: string[] = [];
  for (const rule of parsed.data.rules) {
    if (ids.has(rule.id)) duplicates.push(`rules.${rule.id}: duplicate id`);
    ids.add(rule.id);
  }
  if (duplicates.length > 0) throw new BrandRulesInvalidError(duplicates);
  return {
    rulesVersion: parsed.data.rulesVersion,
    sensitiveTerms: parsed.data.sensitiveAttributeFilter.terms,
    rules: parsed.data.rules.map((rule) => ({ ...rule, rulesVersion: parsed.data.rulesVersion })),
  };
}

/** Checks one stored row (`brand_rules` read back) with the same rules as the file. */
export function parseStoredRule(row: Omit<BrandRule, 'rulesVersion'> & { rulesVersion: number }): BrandRule {
  const parsed = ruleShape.safeParse({
    id: row.id,
    class: row.class,
    clearable: row.clearable,
    kind: row.kind,
    params: row.params,
    message: row.message,
    active: row.active,
  });
  if (!parsed.success) throw new BrandRulesInvalidError(describe(parsed.error));
  return { ...parsed.data, rulesVersion: row.rulesVersion };
}
