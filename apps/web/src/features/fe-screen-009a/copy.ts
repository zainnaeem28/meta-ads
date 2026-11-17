/** SCREEN-009 copy (UI-UX §8 and the frame `SCREEN-009`; error rows come from UI-UX §9.1 through `lib/errors`). */
export const SCREEN_009_COPY = {
  title: 'Final ad',
  fallbackName: 'Campaign',
  stageTabs: 'Campaign stages',
  tabBrief: '1 Brief',
  tabClips: '2 Clips',
  tabFinal: '3 Final',
  loading: 'Loading the final ad',
  selectTitle: 'Choose and order clips',
  selectHint: 'Only completed clips can be used. Move clips to change their order.',
  listLabel: 'Clips for the final ad',
  assemble: 'Assemble final ad',
  moveUp: (n: number) => `Move segment ${n} up`,
  moveDown: (n: number) => `Move segment ${n} down`,
  moved: (n: number, to: number) => `Segment ${n} moved to position ${to}.`,
  summary: (count: number, seconds: number) =>
    `${count} ${count === 1 ? 'clip' : 'clips'} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
  noneSelected: 'Choose at least one clip.',
  qcHeads: (count: number) =>
    `${count} selected ${count === 1 ? 'clip has' : 'clips have'} a failed or skipped audio check. You will be asked to confirm before assembling.`,
  noClipsTitle: 'No completed clips yet',
  noClipsBody:
    'Generate at least one clip first. Completed clips appear here for you to choose and order.',
  goToClips: 'Go to clips',
  qcDialogTitle: 'Assemble with audio checks that did not pass?',
  qcDialogConfirm: 'Assemble anyway',
  qcDialogBack: 'Go back',
  qcDialogAck:
    'I have reviewed these clips and want to use them anyway. This confirmation is recorded.',
  qcDialogAckMissing: 'Tick the box to confirm that you have reviewed these clips.',
  qcFailed: (n: number, reason: string | null) =>
    `Segment ${n} failed its audio check${reason ? ` (${reason})` : ''}.`,
  qcSkipped: (n: number) => `Segment ${n}'s check was skipped.`,
  changedTitle: 'Audio checks changed since this page loaded',
  changedBody: 'Nothing was assembled. Confirm to include them as they are.',
  changedDialogIntro: 'The check results changed since you opened this page.',
  changedFailed: (n: number) => `Segment ${n}: check failed`,
  changedSkipped: (n: number) => `Segment ${n}: check skipped, the audio service did not answer`,
  changedNow: 'Check the results again; none of these clips needs a confirmation any more.',
  capTitle: 'Daily assembly limit reached',
  capBody:
    'You have used all final-ad assemblies for today. Try again after midnight UTC. Your selection and order are kept.',
  assemblingTitle: 'Assembling your final ad',
  assemblingBody:
    'This takes a minute or two. You can leave this page; the final ad appears here when it is done. Submitting the same clips again reuses this job.',
  progressLabel: 'Assembly progress',
  steps: ['Queued', 'Fetching clips', 'Rendering', 'Saving'],
  stepStatus: ['Queued', 'Fetching', 'Rendering', 'Saving'],
  failedTitle: 'Assembly failed',
  failedBody:
    'The final ad could not be made. Regenerate a clip or leave it out, then assemble again.',
  assembleAgain: 'Assemble again',
  doneTitle: 'Final ad',
  doneLabel: 'Final ad',
  outOfDateTitle: 'This final ad is out of date',
  outOfDateBody:
    'A clip was regenerated after this ad was made. Re-assemble to include the new clip. The current file stays available until then.',
  reassemble: 'Re-assemble',
  updating: 'Updating status',
} as const;
