/** SCREEN-009 copy for the finished ad (UI-UX §8 and the frame `SCREEN-009`; error rows come from UI-UX §9.1 through `lib/errors`). */
export const SCREEN_009B_COPY = {
  finalTitle: 'Final ad',
  done: 'Done',
  length: 'Length',
  lengthValue: (seconds: number, clips: number) =>
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} (${clips} ${clips === 1 ? 'clip' : 'clips'})`,
  download: 'Download',
  reassemble: 'Re-assemble',
  downloadHint:
    'The download link works for 5 minutes. If it has expired, choose Download again for a fresh one.',
  outOfDateTitle: 'This final ad is out of date',
  outOfDateClip: (n: number) =>
    `Clip ${n} was regenerated after this ad was made. Re-assemble to include the new clip. The current file stays available until then.`,
  outOfDateBrief:
    'The brief changed after this ad was made. Re-assemble to use the new brief. The current file stays available until then.',
  clipsUsed: 'Clips used',
  segment: (n: number) => `Segment ${n}`,
  qcOverride: 'QC confirmed by you',
  clipOutOfDate: 'Out of date',
  thumbTitle: 'Thumbstopper',
  optional: 'Optional',
  thumbIntro: 'A callout frame to use as the opening hook. Uses your OpenAI key.',
  thumbCost: 'Estimated cost is shown against your daily limit before it runs.',
  calloutLabel: 'Call-out text',
  calloutHelp: 'Up to 80 characters. Claims in it are checked before the image is made.',
  calloutRequired: 'Enter the call-out text.',
  generate: 'Generate thumbstopper',
  generating: 'Generating thumbstopper',
  generatingStatus: 'Generating the thumbstopper. This takes about a minute.',
  ready: 'Ready',
  readyAlt: (text: string) => `Thumbstopper frame with the call-out: ${text}`,
  calloutShown: (text: string) => `Call-out: ${text}`,
  failedTitle: 'The thumbstopper could not be made',
  failedBody: 'Nothing was added to your ad. Try again.',
  retry: 'Try again',
  another: 'Make another',
  loadingThumb: 'Loading the thumbstopper',
} as const;
