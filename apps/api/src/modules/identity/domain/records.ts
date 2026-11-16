// Closed value sets of the identity tables (ARCHITECTURE §2.2); the database repeats them as CHECK constraints.

export const ROLES = ['user', 'admin'] as const;
export const USER_STATUSES = ['active', 'suspended', 'removed'] as const;
export const LINKED_VIA = ['first_admin', 'invitation', 'access_request', 'open_signup'] as const;
export const INVITATION_STATES = ['invited', 'accepted', 'expired', 'revoked'] as const;
export const SEND_STATES = ['pending', 'sent', 'send_failed'] as const;
export const ACCESS_REQUEST_STATES = ['pending', 'approved', 'declined'] as const;
export const SIGNUP_MODES = ['invited_only', 'open'] as const;

export type Role = (typeof ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];
export type LinkedVia = (typeof LINKED_VIA)[number];
export type InvitationState = (typeof INVITATION_STATES)[number];
export type SendState = (typeof SEND_STATES)[number];
export type AccessRequestState = (typeof ACCESS_REQUEST_STATES)[number];
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** Emails are stored lower-cased and trimmed (users, invitations). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
