import { describe, expect, it } from 'vitest';
import { compileRules } from '../../brief/index.js';
import type { BrandRule } from '../../brief/index.js';
import { checkCallout, thumbPrompt, thumbReuseHash } from './thumb-callout.js';

const rule = (over: Partial<BrandRule> & Pick<BrandRule, 'id' | 'kind' | 'params'>): BrandRule =>
  ({ class: 'high_risk', clearable: false, message: `rule ${over.id}`, active: true, rulesVersion: 1, ...over }) as BrandRule;

const rules = compileRules([
  rule({ id: 'hr_cure', kind: 'regex', params: { pattern: '\\bcures?\\b' } }),
  rule({ id: 'other_hype', kind: 'phrase', class: 'other', clearable: true, params: { phrases: ['game changer'] } }),
  rule({ id: 'prompt_only', kind: 'phrase', params: { phrases: ['forbidden'], fields: ['prompt'] } }),
  rule({ id: 'other_dash', kind: 'em_dash', class: 'other', clearable: true, params: {} }),
  rule({ id: 'other_min', kind: 'word_count_min', class: 'other', clearable: true, params: { min: 20 } }),
  rule({ id: 'other_cta', kind: 'cta_exact', class: 'other', clearable: true, params: { text: 'Order now' } }),
  rule({ id: 'other_age', kind: 'age_framing', class: 'other', clearable: true, params: { patterns: ['21\\+'] } }),
  rule({ id: 'off', kind: 'phrase', active: false, params: { phrases: ['quiet'] } }),
] as BrandRule[]);

describe('checkCallout', () => {
  it('passes plain text, however short: the structural rules judge a script, not a call-out', () => {
    expect(checkCallout(rules, 'Hi')).toEqual([]);
  });

  it('raises one issue per matching rule, with its class and message, whichever field the rule reads', () => {
    const issues = checkCallout(rules, 'It cures. A game changer — forbidden');
    expect(issues.map((i) => i.ruleId).sort()).toEqual(['hr_cure', 'other_dash', 'other_hype', 'prompt_only']);
    expect(issues.find((i) => i.ruleId === 'hr_cure')).toEqual({ ruleId: 'hr_cure', class: 'high_risk', message: 'rule hr_cure' });
  });

  it('ignores a rule that is switched off', () => {
    expect(checkCallout(rules, 'quiet')).toEqual([]);
  });
});

describe('thumbReuseHash and thumbPrompt', () => {
  it('hashes the campaign, the text and the model apart from each other', () => {
    const base = thumbReuseHash('c1', 'text', 'm1');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(thumbReuseHash('c1', 'text', 'm1')).toBe(base);
    expect(new Set([thumbReuseHash('c2', 'text', 'm1'), thumbReuseHash('c1', 'text2', 'm1'), thumbReuseHash('c1', 'text', 'm2'), thumbReuseHash('c1text', '', 'm1')]).size).toBe(4);
  });

  it('quotes the call-out as text to draw, and cannot be closed from inside', () => {
    const prompt = thumbPrompt('Say "hi" now');
    expect(prompt).toContain('The call-out reads exactly: "Say \'hi\' now"');
    expect(prompt.endsWith('"Say \'hi\' now"')).toBe(true);
  });
});
