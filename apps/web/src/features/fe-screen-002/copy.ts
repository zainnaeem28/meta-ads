/** Copy for SCREEN-002 (UI-UX §8 and §9.1). No state names an account, an address or whether one exists. */
export const SCREEN_002_STATES = ['not-linked', 'request-pending', 'suspended', 'removed', 'invite-invalid'] as const;
export type Screen002State = (typeof SCREEN_002_STATES)[number];

/** States a visitor can be sent to by name (`?state=`); the others are decided by API-001. */
const NAMED = ['not-linked', 'suspended', 'removed', 'invite-invalid'] as const;
export type NamedState = (typeof NAMED)[number];

export const parseNamedState = (value: string | string[] | undefined): NamedState | null => {
  const v = Array.isArray(value) ? value[0] : value;
  return NAMED.find((s) => s === v) ?? null;
};

export const SCREEN_002_COPY = {
  'not-linked': {
    title: 'This account has no access yet',
    body: 'Your account is not set up for this workspace yet. Ask for access below, or ask an administrator for an invitation.',
  },
  'request-pending': {
    title: 'Request sent',
    body: 'An administrator will review it. You will be able to sign in once it is approved. Nothing else is needed from you.',
  },
  suspended: {
    title: 'This account is suspended',
    body: 'Your account is suspended. Contact your administrator.',
  },
  removed: {
    title: 'This account has been removed.',
    body: 'It can no longer be used to sign in.',
  },
  'invite-invalid': {
    title: 'This invitation cannot be used',
    body: 'It may have expired, been used already, or been withdrawn. Ask an administrator to send a new one.',
  },
} as const satisfies Record<Screen002State, { title: string; body: string }>;

export const ACCESS_FORM_COPY = {
  label: 'Tell your administrator who you are',
  help: 'Your email address from sign-in is sent with the request. Do not include passwords or keys.',
  submit: 'Request access',
  pending: 'Sending…',
  back: 'Back to sign in',
  loading: 'Checking your account',
  /** API-002 answered not_found: the form is switched off. Same neutral wording for every address. */
  formOff: 'Requests are not being taken. Ask an administrator for an invitation.',
  tryAgain: 'Try again',
  checkFailedTitle: 'We could not check your account',
  noteTooLong: 'Keep this to 500 characters or fewer.',
} as const;

export const NOTE_MAX = 500;

/** Icon of each state's glyph (frame SCREEN-002). */
export const STATE_ICON = {
  'not-linked': 'lock',
  'request-pending': 'clock',
  suspended: 'ban',
  removed: 'user-x',
  'invite-invalid': 'mail',
} as const;
