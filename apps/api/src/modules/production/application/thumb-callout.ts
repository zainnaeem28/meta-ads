import { createHash } from 'node:crypto';
import { checkSegment } from '../../brief/index.js';
import type { CompiledRules } from '../../brief/index.js';

/** The rule kinds that read free text. The structural ones (word count, call to action, age framing) judge a script, not a call-out. */
const TEXT_RULE_KINDS = new Set(['phrase', 'regex', 'em_dash']);

export interface CalloutIssue {
  readonly ruleId: string;
  readonly class: 'high_risk' | 'other';
  readonly message: string;
}

/** The claim engine over the call-out text (REQ-022): one issue per rule that matches, whichever field the rule reads. */
export function checkCallout(rules: CompiledRules, calloutText: string): CalloutIssue[] {
  const textRules = rules.filter((compiled) => TEXT_RULE_KINDS.has(compiled.rule.kind));
  const seen = new Set<string>();
  const issues: CalloutIssue[] = [];
  // The text stands for both fields a rule may read, so a rule written for the prompt catches it too.
  for (const finding of checkSegment(textRules, { dialogue: calloutText, prompt: calloutText, isLast: false })) {
    if (seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);
    issues.push({ ruleId: finding.ruleId, class: finding.class, message: finding.message });
  }
  return issues;
}

/** SHA-256 hex of what makes two thumbstoppers the same work: the campaign, the text and the model. */
export function thumbReuseHash(campaignId: string, calloutText: string, model: string): string {
  return createHash('sha256').update(JSON.stringify(['thumbstopper', campaignId, calloutText, model])).digest('hex');
}

/** The image prompt: the call-out text is the only user words in it, quoted so it reads as text to draw, not as an instruction. */
export function thumbPrompt(calloutText: string): string {
  return [
    'A bold, high-contrast thumbnail frame for a vertical 9:16 social video.',
    'A single short call-out set in large, clean, highly legible type, centred on a plain graphic background.',
    'No logos, no people, no other text.',
    `The call-out reads exactly: "${calloutText.replace(/"/g, "'")}"`,
  ].join(' ');
}
