/** SCREEN-013 copy (UI-UX §8, §9.1 and frame SCREEN-013). Error copy comes from `lib/errors`. */
export const SETTINGS_COPY = {
  title: 'Settings',
  description: 'Platform-wide sign-up and security. Changes are recorded in the audit trail.',
  loading: 'Loading settings',
  saved: 'Sign-up mode saved.',
  signup: { title: 'Sign-up', sub: 'Who can create an account' },
  modeLegend: 'Sign-up mode',
  invitedOnly: {
    label: 'Invited only',
    description: 'People join by invitation or after you approve a request. Recommended.',
  },
  open: {
    label: 'Open',
    description: 'Anyone can create an account. Needs the safeguards below.',
  },
  prerequisites: {
    email: 'Email verification',
    limits: 'Rate limiting and abuse limits',
    record: 'Verification record',
  },
  save: 'Save sign-up mode',
  saving: 'Saving',
  security: { title: 'Security and access', sub: 'Set at deployment. Read-only here.', badge: 'Read-only' },
  mfa: {
    label: 'Two-step verification required for',
    all: 'Everyone',
    admins: 'Administrators only',
  },
  accessForm: 'Request-access form on sign-in page',
  inviteLifetime: 'Invitation lifetime',
} as const;

/** `INVITE_EXPIRY_DAYS` default of the api; API-120 does not return it yet (see the hand-off note). */
export const INVITE_LIFETIME_DAYS = 7;
