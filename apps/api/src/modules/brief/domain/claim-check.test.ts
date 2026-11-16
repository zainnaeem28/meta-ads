import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBrandRules } from './brand-rules.js';
import type { BrandRule } from './brand-rules.js';
import { checkBrief, checkSegment, compileRules } from './claim-check.js';
import type { CompiledRules, Finding, SegmentText } from './claim-check.js';
import { countWords, removeDashes, shortenDialogue } from './words.js';

const FILE = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'config', 'brand-rules.json');
const set = parseBrandRules(JSON.parse(readFileSync(FILE, 'utf8')) as unknown);
const rules: CompiledRules = compileRules(set.rules);

const CTA = 'Take the free 2-minute quiz';
/** n words in sentences of five words, none of them a claim. */
const calm = (n: number): string =>
  Array.from({ length: n }, (_, i) => (i % 5 === 4 || i === n - 1 ? `calm${String(i)}.` : `calm${String(i)}`)).join(' ');
const middle = (dialogue: string, prompt = ''): SegmentText => ({ dialogue, prompt, isLast: false });
const last = (dialogue: string, prompt = ''): SegmentText => ({ dialogue, prompt, isLast: true });
const ids = (findings: readonly Finding[]): string[] => findings.map((f) => f.ruleId);
/** A middle segment of 35 calm words, so only the claim rules can fire. */
const inBand = (extra: string): string => `${extra} ${calm(31)}`;

describe('the shipped rule file', () => {
  it('parses, with a high-risk rule for each class of claim and every other-class kind', () => {
    expect(set.rulesVersion).toBeGreaterThan(0);
    const highRisk = set.rules.filter((rule) => rule.class === 'high_risk');
    expect(highRisk.map((rule) => rule.id).sort()).toEqual(['hr_diagnosis', 'hr_dosing', 'hr_psychedelic', 'hr_treatment_cure']);
    expect(highRisk.every((rule) => !rule.clearable)).toBe(true);
    expect(set.rules.filter((rule) => rule.class === 'other').every((rule) => rule.clearable)).toBe(true);
    expect(new Set(set.rules.map((rule) => rule.kind))).toEqual(
      new Set(['phrase', 'regex', 'word_count_min', 'word_count_max_target', 'cta_exact', 'em_dash', 'age_framing']),
    );
    expect(set.sensitiveTerms).toContain('ethnicity');
  });
});

describe('high-risk claims (TC-BRF-02, TC-REV-01)', () => {
  const fixtures: [string, string][] = [
    ['cures anxiety', 'hr_treatment_cure'],
    ['treats depression', 'hr_treatment_cure'],
    ['This tea can treat your anxiety.', 'hr_treatment_cure'],
    ['A miracle cure for sleep', 'hr_treatment_cure'],
    ['Clinically proven to help', 'hr_treatment_cure'],
    ['you have anxiety', 'hr_diagnosis'],
    ['You might have depression, so', 'hr_diagnosis'],
    ["You're depressed and tired", 'hr_diagnosis'],
    ['you are anxious', 'hr_diagnosis'],
    ['take 2g', 'hr_dosing'],
    ['Take 250 mg each night', 'hr_dosing'],
    ['microdose', 'hr_dosing'],
    ['the right dosage for you', 'hr_dosing'],
    ['psychedelic trip', 'hr_psychedelic'],
    ['A Psilocybin story', 'hr_psychedelic'],
    ['magic mushrooms at home', 'hr_psychedelic'],
  ];

  it.each(fixtures)('flags "%s" as %s, high risk and not clearable', (text, ruleId) => {
    const found = checkSegment(rules, middle(inBand(text)));
    const hit = found.find((finding) => finding.ruleId === ruleId);
    expect(hit?.class).toBe('high_risk');
    expect(hit?.field).toBe('dialogue');
    expect(hit?.spanStart).not.toBeNull();
    expect(inBand(text).slice(hit?.spanStart ?? 0, hit?.spanEnd ?? 0).length).toBeGreaterThan(0);
    expect(found.every((finding) => finding.class !== 'high_risk' || set.rules.find((r) => r.id === finding.ruleId)?.clearable === false)).toBe(true);
  });

  it('points the span at the offending text', () => {
    const text = inBand('It cures anxiety fast');
    const hit = checkSegment(rules, middle(text)).find((finding) => finding.ruleId === 'hr_treatment_cure');
    expect(text.slice(hit?.spanStart ?? 0, hit?.spanEnd ?? 0)).toBe('cures anxiety');
  });

  it('checks the prompt as well as the dialogue, and reports each field once per rule', () => {
    const found = checkSegment(rules, middle(inBand('Rest well'), 'A person says it cures anxiety and cures pain'));
    const prompt = found.filter((finding) => finding.field === 'prompt');
    expect(ids(prompt)).toEqual(['hr_treatment_cure']);
  });

  it('raises nothing high risk for neutral sentences', () => {
    for (const text of [
      'A calm evening with friends.',
      'Treat yourself to a quiet moment.',
      'Answer a few questions about your evening routine.',
      'Open in 2 minutes, no pressure.',
      'We ship in 21 days.',
    ]) {
      expect(checkSegment(rules, middle(inBand(text))).filter((f) => f.class === 'high_risk')).toEqual([]);
    }
  });
});

describe('word count (TC-BRF-03)', () => {
  const flagged = (n: number): string[] => ids(checkSegment(rules, middle(calm(n))));

  it('flags under the 32 word target, and nothing from 32 to 42', () => {
    for (const n of [29, 30, 31]) expect(flagged(n)).toEqual(['other_word_count_min']);
    for (const n of [32, 37, 42]) expect(flagged(n)).toEqual([]);
  });

  it('flags 43 to 45 and above as over target', () => {
    for (const n of [43, 45, 46, 50]) expect(flagged(n)).toEqual(['other_word_count_max']);
  });

  it('shortens a 46 or 50 word draft to at most 45 words, which the rules still flag as over the 42 target', () => {
    for (const n of [46, 50]) {
      const shortened = shortenDialogue(calm(n)).text;
      expect(countWords(shortened)).toBeLessThanOrEqual(45);
      expect(ids(checkSegment(rules, middle(shortened)))).toEqual(['other_word_count_max']);
    }
  });

  it('flags an empty dialogue as under target, without a span', () => {
    const found = checkSegment(rules, middle(''));
    expect(found).toEqual([expect.objectContaining({ ruleId: 'other_word_count_min', spanStart: null, spanEnd: null })]);
  });
});

describe('the other classes', () => {
  const ok = `${calm(30)} ${CTA}.`; // 35 words with the CTA and no 21+ framing yet

  it('wants the exact call to action in the last segment only', () => {
    expect(ids(checkSegment(rules, last(calm(35))))).toContain('other_cta_exact');
    expect(ids(checkSegment(rules, last(ok)))).not.toContain('other_cta_exact');
    expect(ids(checkSegment(rules, last(ok.replace('Take', 'take'))))).toContain('other_cta_exact');
    expect(ids(checkSegment(rules, middle(calm(35))))).not.toContain('other_cta_exact');
  });

  it('wants 21+ framing in the last segment, in the dialogue or the prompt', () => {
    expect(ids(checkSegment(rules, last(ok)))).toContain('other_age_framing');
    for (const framing of ['For adults 21+ only.', 'Made for adults 21 and over.', 'adults 21 and up', 'Only for people over 21.']) {
      expect(ids(checkSegment(rules, last(`${ok} ${framing}`.slice(0, 400))))).not.toContain('other_age_framing');
    }
    expect(ids(checkSegment(rules, last(ok, 'On screen: adults 21+')))).not.toContain('other_age_framing');
    expect(ids(checkSegment(rules, middle(calm(35))))).not.toContain('other_age_framing');
  });

  it('flags an em dash left in public copy, and none once removed (TC-BRF-04)', () => {
    const text = `${calm(33)} slow — steady`;
    expect(ids(checkSegment(rules, middle(text)))).toContain('other_em_dash');
    expect(ids(checkSegment(rules, middle(removeDashes(text))))).not.toContain('other_em_dash');
  });

  it('flags hype in the tone rule', () => {
    expect(ids(checkSegment(rules, middle(inBand('A true game changer'))))).toContain('other_tone_hype');
  });

  it('skips a rule that is switched off', () => {
    const off = compileRules(set.rules.map((rule): BrandRule => ({ ...rule, active: false })));
    expect(off).toEqual([]);
    const some = compileRules(set.rules.map((rule): BrandRule => ({ ...rule, active: rule.id === 'other_tone_hype' })));
    expect(ids(checkSegment(some, middle('take 2g, a game changer')))).toEqual(['other_tone_hype']);
  });
});

describe('checkBrief', () => {
  it('treats the highest position as the last segment and positions each finding', () => {
    const found = checkBrief(rules, [
      { position: 1, dialogue: calm(35), prompt: '' },
      { position: 2, dialogue: calm(35), prompt: '' },
    ]);
    expect(found.filter((f) => f.ruleId === 'other_cta_exact').map((f) => f.position)).toEqual([2]);
    expect(checkBrief(rules, [])).toEqual([]);
  });

  it('is a pure function of its input', () => {
    const input = [{ position: 1, dialogue: 'cures anxiety', prompt: '' }];
    expect(checkBrief(rules, input)).toEqual(checkBrief(rules, input));
  });
});
