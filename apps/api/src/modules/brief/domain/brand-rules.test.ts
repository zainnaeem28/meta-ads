import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrandRulesInvalidError, parseBrandRules, parseStoredRule } from './brand-rules.js';

const FILE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'config',
  'brand-rules.json',
);
const good = (): Record<string, unknown> =>
  JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>;
const rule = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'x_rule',
  class: 'other',
  clearable: true,
  kind: 'phrase',
  params: { phrases: ['a'] },
  message: 'm',
  active: true,
  ...over,
});
const withRules = (...rules: Record<string, unknown>[]): Record<string, unknown> => ({
  ...good(),
  rules,
});
const issuesOf = (content: unknown): string => {
  try {
    parseBrandRules(content);
  } catch (error) {
    expect(error).toBeInstanceOf(BrandRulesInvalidError);
    return (error as BrandRulesInvalidError).message;
  }
  return '';
};

describe('parseBrandRules', () => {
  it('accepts the shipped file and stamps the version on every rule', () => {
    const set = parseBrandRules(good());
    expect(set.rules.length).toBeGreaterThan(5);
    expect(set.rules.every((r) => r.rulesVersion === set.rulesVersion)).toBe(true);
  });

  it('refuses a clearable high-risk rule and a non-clearable other rule', () => {
    expect(issuesOf(withRules(rule({ class: 'high_risk', clearable: true })))).toContain(
      'rules.0.clearable',
    );
    expect(issuesOf(withRules(rule({ clearable: false })))).toContain('rules.0.clearable');
  });

  it('refuses a bad shape, version, kind, id, duplicate id and unknown key', () => {
    expect(issuesOf({ ...good(), version: 2 })).toContain('version');
    expect(issuesOf({ ...good(), extra: 1 })).toContain('extra');
    expect(issuesOf({ ...good(), rules: [] })).toContain('rules');
    expect(issuesOf(withRules(rule({ kind: 'sentiment' })))).toContain('rules.0.kind');
    expect(issuesOf(withRules(rule({ id: 'Bad Id' })))).toContain('rules.0.id');
    expect(issuesOf(withRules(rule({ extra: 1 })))).toContain('rules.0');
    expect(issuesOf(withRules(rule({}), rule({})))).toContain('duplicate id');
    expect(issuesOf('not an object')).toContain('(file)');
    expect(issuesOf({ ...good(), sensitiveAttributeFilter: { terms: [] } })).toContain(
      'sensitiveAttributeFilter',
    );
  });

  it('checks the parameters of each kind', () => {
    const bad = (kind: string, params: unknown): string =>
      issuesOf(withRules(rule({ kind, params })));
    expect(bad('phrase', { phrases: [] })).toContain('params.phrases');
    expect(bad('phrase', { phrases: ['a'], fields: [] })).toContain('params.fields');
    expect(bad('regex', { pattern: '(' })).toContain('valid regular expression');
    expect(bad('regex', { pattern: '(a+)+' })).toContain('nested quantifier');
    expect(bad('regex', { pattern: 'a'.repeat(1201) })).toContain('params.pattern');
    expect(bad('word_count_min', { min: 0 })).toContain('params.min');
    expect(bad('word_count_max_target', { target: 45, hardMax: 42 })).toContain('hardMax');
    expect(bad('cta_exact', {})).toContain('params.text');
    expect(bad('em_dash', { x: 1 })).toContain('params');
    expect(bad('age_framing', { patterns: ['['] })).toContain('params.patterns');
    expect(bad('phrase', { phrases: ['a'], fields: ['prompt'] })).toBe('');
  });
});

describe('parseStoredRule', () => {
  const row = {
    id: 'r',
    class: 'other' as const,
    clearable: true,
    kind: 'em_dash' as const,
    params: {},
    message: 'm',
    rulesVersion: 3,
    active: true,
  };

  it('reads a stored row back with its version', () => {
    expect(parseStoredRule(row)).toEqual(row);
  });

  it('refuses a stored row that breaks the file rules', () => {
    expect(() => parseStoredRule({ ...row, class: 'high_risk' })).toThrow(BrandRulesInvalidError);
    expect(() => parseStoredRule({ ...row, params: { a: 1 } })).toThrow('params');
  });
});
