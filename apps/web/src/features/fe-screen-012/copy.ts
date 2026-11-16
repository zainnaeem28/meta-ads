/** SCREEN-012 copy (UI-UX §8, frame SCREEN-012 and §9.1). */
export const COPY = {
  title: 'Invitations and requests',
  description: 'Invite people, or approve people who asked for access.',
  invite: 'Invite person',
  tabsLabel: 'Invitations and access requests',
  loading: 'Loading',
  empty: {
    title: 'No invitations yet',
    body: 'Invite the people who should use ShrooMap. They get a single-use link that works for 7 days.',
  },
  requestsEmpty: {
    title: 'No access requests',
    body: 'When someone asks for access from the sign-in page, the request appears here.',
  },
  requestsOff: {
    title: 'The request-access form is off',
    body: 'People cannot ask for access from the sign-in page. Invite them instead. Turning the form on is a deployment setting.',
  },
  dialog: {
    title: 'Invite a person',
    description: 'They get a single-use link that works for 7 days.',
    email: 'Email address',
    send: 'Send invitation',
    required: 'Enter an email address.',
    malformed: 'Enter a valid email address, for example name@company.example.',
  },
  revoke: {
    title: 'Revoke this invitation?',
    body: (email: string) => `${email} will no longer be able to use the invitation link.`,
    confirm: 'Revoke invitation',
  },
  toast: {
    // The same words for a new and an already registered address (API-111, REQ-003).
    invited: 'If this address can be invited, an invitation is on its way.',
    resent: 'Invitation sent again. The 7-day period starts over.',
    revoked: 'Invitation revoked.',
    approved: 'Request approved.',
    declined: 'Request declined.',
  },
} as const;

export type InvitationStateView = {
  label: string;
  variant: 'info' | 'warning' | 'success' | 'neutral';
  icon: 'mail' | 'clock' | 'triangle-alert' | 'circle-check' | 'ban';
};

export const COLUMNS = {
  invitations: { email: 'Email', state: 'State', by: 'Invited by', expires: 'Expires', actions: 'Actions' },
  requests: { email: 'Email', note: 'Note', asked: 'Asked', actions: 'Actions' },
} as const;
