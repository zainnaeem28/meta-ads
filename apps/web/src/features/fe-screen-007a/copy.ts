import type { ClaimIssue } from '@shroomap/contracts';

/** SCREEN-007 copy (UI-UX §8 and the frame `SCREEN-007`; error rows come from UI-UX §9.1 through `lib/errors`). */
export const SCREEN_007_COPY = {
  title: 'Brief',
  fallbackName: 'Campaign',
  loadingBrief: 'Loading the brief',
  generatingTitle: 'Generating your brief',
  generatingBody: 'This usually takes under a minute. You can leave this page and come back; it keeps running.',
  failedTitle: 'The brief could not be generated',
  failedFallback: 'The brief could not be generated. Nothing was charged. Your answers are saved.',
  editAnswers: 'Edit answers',
  accept: 'Accept brief',
  accepting: 'Accepting',
  save: 'Save changes',
  saving: 'Saving',
  continueToClips: 'Continue to clips',
  acceptedTitle: 'Brief accepted · all checks closed',
  acceptedBody: 'Segment prompts are ready for clip generation. Editing any segment reopens the brief for acceptance.',
  acceptedToast: 'Brief accepted.',
  savedToast: 'Changes saved. Brand checks ran again.',
  blockedTitle: 'The brief cannot be accepted yet',
  reasonOpenIssues: (n: number, high: number) =>
    `${n} ${n === 1 ? 'issue is' : 'issues are'} still open${high > 0 ? `, including ${high} that must be fixed by editing the text` : ''}. Resolve them, then accept.`,
  reasonUnsaved: 'Save your changes before you accept the brief.',
  reasonTooLong: (segment: number) => `Segment ${segment} is over the 45 word limit. Shorten it to continue.`,
  reasonFresh: 'Accept brief is available once the brief has no open issues.',
  issuesTitle: (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'} to resolve`,
  issuesNote: 'Brand checks ran on the generated text. Open issues block acceptance.',
  highRisk: 'High risk',
  other: 'Other',
  editSegment: (n: number) => `Edit segment ${n}`,
  highRiskNote: 'Treatment, cure and dosing wording cannot be cleared with a reason. Edit the text until this check no longer finds it.',
  segmentHeading: (n: number) => `Segment ${n} · ${seconds((n - 1) * 15)} to ${seconds(n * 15)}`,
  segmentIssues: (n: number) => (n === 1 ? '1 issue' : `${n} issues`),
  visualPrompt: 'Visual prompt',
  promptHelp: 'The product must be visible, described in one sentence. Prompts are checked with the same brand rules.',
  aside: 'Campaign details',
  asideTitle: 'Campaign',
  asideProduct: 'Product',
  asideLength: 'Length',
  asideAudience: 'Audience',
  asideChecks: 'Brand checks',
  asideChecksNote:
    'Treatment, cure and dosing wording cannot be cleared with a reason. Other checks can, with a recorded reason.',
  openIssues: 'Open issues',
  intakeLink: 'View intake answers',
  keyMissingTitle: 'Regenerating needs your OpenAI key',
  keyMissingBody: 'Add your key to regenerate. You can keep editing this brief in the meantime.',
  keyMissingAction: 'Add OpenAI key',
  keyDisabledTitle: 'Your OpenAI key was disabled',
  keyDisabledBody: 'Replace it to regenerate. You can keep editing this brief in the meantime.',
  keyDisabledAction: 'Replace OpenAI key',
  latestTitle: 'Latest version',
  latestNote: 'Your unsaved text stays in the editor. Choose which to keep.',
  useLatest: 'Use the latest text',
  stageTabs: 'Campaign stages',
  tabBrief: '1 Brief',
  tabClips: '2 Clips',
  tabFinal: '3 Final',
  clipsDisabled: 'Available once the brief is accepted',
  stateBadge: {
    generating: 'Generating',
    draft: 'Needs review',
    accepted: 'Accepted',
    failed: 'Generation failed',
  },
} as const;

function seconds(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Heading of one claim issue: the field it was found in and its segment. */
export const issueHeading = (issue: ClaimIssue): string =>
  `${issue.field === 'dialogue' ? 'Dialogue' : 'Visual prompt'} · Segment ${issue.segmentPosition}`;
