import type { KeyEvent, ProviderKeyStatus } from '@shroomap/contracts';
import type { KeyCardState } from '@shroomap/ui/cmp-025';
import type { IconName } from '@shroomap/ui/icons';

export type ProviderName = ProviderKeyStatus['provider'];

/** Days backups keep a deleted key (G-3 default; the retention is configurable). */
export const BACKUP_RETENTION_DAYS = 30;

/** SCREEN-010 copy (UI-UX §7 frame text, §8, §9.1). Keys are never named or echoed here. */
export const SCREEN_010_COPY = {
  title: 'Provider keys',
  description:
    'ShrooMap generates on your own OpenAI and WaveSpeed accounts. Keys are stored encrypted and can never be shown again, to you or anyone else.',
  loading: 'Loading provider keys',
  cardsLabel: 'Provider keys',
  emptyTitle: 'Add both keys to create ads',
  emptyBody: 'Briefs run on your OpenAI key and clips on your WaveSpeed key. Nothing is charged to anyone else.',
  reminder: 'You will not be able to see the full key again.',
  protectedTitle: 'How your keys are protected',
  protectedBody:
    'Keys are encrypted on the server, used only for your own jobs, and never sent to your browser or visible to administrators. Adding, replacing or deleting a key needs a recent sign-in.',
  eventsTitle: 'Key activity',
  eventsNote: 'Never includes key values',
  eventsEmpty: 'No key activity yet.',
  eventsLoading: 'Loading key activity',
  showMore: 'Show more',
  fieldPaste: 'Paste your key',
  fieldNew: 'Paste your new key',
  fieldEmpty: 'Paste your key before testing it.',
  fieldHelp: 'Pasting is fine. Spaces at the ends are removed. The key is tested once without being charged and then stored encrypted.',
  replaceHelp: 'The new key is tested first. If the test fails, your current key stays.',
  testing: 'Testing the key. This can take a few seconds.',
  testAndSave: 'Test and save',
  testAndReplace: 'Test and replace',
  cancel: 'Cancel',
  deleteConfirm: 'Delete key',
  untestedNote:
    'This key could not be tested without a charge, so it is checked by your first job. If that fails, the key is marked invalid.',
  deletedToast: (name: string) => `${name} key deleted.`,
  retention: `Backups age out within ${String(BACKUP_RETENTION_DAYS)} days.`,
} as const;

export const PROVIDER_COPY: Record<ProviderName, { name: string; purpose: string; advice: string; uses: string }> = {
  openai: {
    name: 'OpenAI',
    purpose: 'Used for briefs, script suggestions, image analysis and audio checks.',
    advice: 'Use an OpenAI project key limited to this project, not an account-wide key.',
    uses: 'briefs',
  },
  wavespeed: {
    name: 'WaveSpeed',
    purpose: 'Used to generate the video clips.',
    advice: 'Use a WaveSpeed key with the inference scope only; it needs no other permission.',
    uses: 'clips',
  },
};

export const PROVIDERS: readonly ProviderName[] = ['openai', 'wavespeed'];

export const cardState = (key: ProviderKeyStatus | undefined): KeyCardState => {
  if (!key || !key.configured) return 'none';
  return key.status ?? 'active';
};

export const savedMessage = (name: string, last4: string | null, probe: 'valid' | 'unknown') => ({
  title: `${name} key saved`,
  body: `It ends in …${last4 ?? ''}. ${SCREEN_010_COPY.reminder} If you replace it later, remember to revoke the old one at ${name}.${probe === 'unknown' ? ` ${SCREEN_010_COPY.untestedNote}` : ''}`,
});

export const disabledMessage = (name: string, uses: string) => ({
  title: `Your ${name} key was disabled`,
  body: `It failed authentication 5 times in a row. Replace it to generate ${uses} again. This notice stays until you do.`,
});

export const replaceWarning = (jobs: number): string =>
  `${String(jobs)} ${jobs === 1 ? 'job is' : 'jobs are'} running on the current key. ${jobs === 1 ? 'It' : 'They'} will fail with "key replaced during the job". Credit already used at the provider cannot be recovered.`;

export const deleteBody = (name: string, jobs: number, uses: string): string[] => [
  `The encrypted key is erased immediately. ${jobs > 0 ? `${String(jobs)} ${jobs === 1 ? 'job' : 'jobs'} running on it will fail cleanly. ` : 'Jobs running on it fail cleanly. '}${SCREEN_010_COPY.retention}`,
  `You will not be able to generate ${uses} until you add a ${name} key again.`,
];

const EVENT: Record<KeyEvent['kind'], { icon: IconName; tone: string; label: (name: string) => string }> = {
  added: { icon: 'circle-check', tone: 'text-success', label: (n) => `${n} key added` },
  replaced: { icon: 'refresh-cw', tone: 'text-foreground', label: (n) => `${n} key replaced` },
  deleted: { icon: 'trash-2', tone: 'text-foreground', label: (n) => `${n} key deleted` },
  test_passed: { icon: 'circle-check', tone: 'text-success', label: (n) => `${n} key test passed` },
  test_failed: { icon: 'circle-x', tone: 'text-destructive', label: (n) => `${n} key test failed (authentication)` },
  stored_untested: { icon: 'clock', tone: 'text-warning', label: (n) => `${n} key stored without a test` },
  validated_by_job: { icon: 'circle-check', tone: 'text-success', label: (n) => `${n} key confirmed by a job` },
  auth_failed: { icon: 'circle-x', tone: 'text-destructive', label: (n) => `${n} refused the key` },
  disabled: { icon: 'circle-x', tone: 'text-destructive', label: (n) => `${n} key disabled after repeated refusals` },
  disabled_by_operator: { icon: 'circle-x', tone: 'text-destructive', label: (n) => `${n} key disabled by an administrator` },
  attempt_rate_limited: { icon: 'clock', tone: 'text-warning', label: (n) => `Too many ${n} key attempts` },
  rewrapped: { icon: 'shield-check', tone: 'text-foreground', label: (n) => `${n} key re-encrypted` },
};

export function presentEvent(event: KeyEvent) {
  const name = PROVIDER_COPY[event.provider]?.name ?? 'Provider';
  const row = EVENT[event.kind] ?? { icon: 'info' as IconName, tone: 'text-foreground', label: (n: string) => `${n} key activity` };
  return { icon: row.icon, tone: row.tone, label: row.label(name) };
}

const STAMP = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** `3 Nov, 09:14` (the browser's time zone); empty for an unreadable instant. */
export function formatEvent(instant: string): string {
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? '' : STAMP.format(at);
}

/** `12 Nov 2026, 09:41` for the card's "Last tested". */
export function formatTested(instant: string | null): string | undefined {
  if (!instant) return undefined;
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? undefined : `${DAY.format(at)}, ${TIME.format(at)}`;
}
