/** SCREEN-011 copy (UI-UX §8, frame SCREEN-011 and §9.1). */
export const COPY = {
  title: 'Accounts',
  description:
    "Email addresses appear only on this screen. Suspending is reversible; removing erases a person's data and cannot be undone.",
  invite: 'Invite person',
  tabsLabel: 'Accounts and account erasures',
  searchLabel: 'Search this page by email',
  empty: {
    title: 'No accounts match',
    body: 'No account has this status.',
  },
  onlyYou: 'You are the only person here. Invite your team to get started.',
  error: { title: 'Accounts could not be loaded', body: 'Nothing has changed. Try again in a moment.' },
  you: 'You',
  paging: {
    label: 'Pagination',
    previous: 'Previous',
    next: 'Next',
    count: (n: number) => (n === 1 ? '1 account' : `${n} accounts`),
  },
  dialog: {
    title: 'Invite a person',
    description:
      'They get a single-use link that works for 7 days. If the address already has an account, you will see the same confirmation.',
    email: 'Email address',
    send: 'Send invitation',
    required: 'Enter an email address.',
    malformed: 'Enter a valid email address, for example name@company.example.',
  },
  suspend: {
    title: (email: string) => `Suspend ${email}?`,
    body: 'They are signed out at once and cannot sign in. Their campaigns are kept but unreachable by anyone. Jobs still running are cancelled. You can reinstate the account at any time.',
    confirm: 'Suspend account',
  },
  remove: {
    title: 'Remove this account permanently?',
    body: 'This cannot be undone. Erased at once: sign-in, stored provider keys, campaigns, clips, final ads and uploaded images. Kept as IDs only: usage and audit records. Spent provider credit cannot be recovered. To keep their work, suspend the account instead.',
    confirm: 'Remove account',
  },
  toast: {
    invited: 'Invitation sent.',
    suspended: 'Account suspended.',
    reinstated: 'Account reinstated.',
    removed: 'Removal started. Progress is under Account erasures.',
    granted: 'Administrator access granted.',
    revoked: 'Administrator access revoked.',
  },
  erasures: {
    title: 'Account erasures',
    note: 'Shows user IDs and progress only. No email or content.',
    empty: { title: 'No erasures', body: 'When an account is removed, its erasure appears here.' },
    userId: 'User ID',
    step: 'Step',
    state: 'State',
    left: 'Objects left',
  },
} as const;

export const COLUMNS = {
  account: 'Account',
  role: 'Role',
  status: 'Status',
  added: 'Added',
  actions: 'Actions',
} as const;

export const STATUS_FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'suspended', label: 'Suspended' },
  { id: 'removed', label: 'Removed' },
] as const;

/** The five steps of an account erasure run (ARCHITECTURE §5.8). */
export const ERASURE_STEPS: Record<number, string> = {
  1: 'Sign out everywhere',
  2: 'Delete sign-in identity',
  3: 'Remove stored media',
  4: 'Check nothing is left',
  5: 'Delete account record',
};
