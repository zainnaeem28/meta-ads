// The audit action catalogue (ARCHITECTURE §7.4) and the alert kinds of `admin_alerts.kind`. Checked in code.

export const AUDIT_ACTIONS = [
  'auth.first_admin_seeded',
  'auth.linked',
  'auth.denied',
  'access.denied_foreign',
  'account.suspended',
  'account.reinstated',
  'account.removed',
  'account.erasure_completed',
  'account.erasure_stuck',
  'admin_invariant.refused',
  'role.granted',
  'role.revoked',
  'invitation.created',
  'invitation.resent',
  'invitation.revoked',
  'access_request.created',
  'access_request.approved',
  'access_request.declined',
  'signup_mode.changed',
  'key.added',
  'key.replaced',
  'key.deleted',
  'key.disabled',
  'key.disabled_all',
  'kek.rewrapped',
  'first_admin.reopened',
  'draft.deleted',
  'campaign.deleted',
  'campaign.deletion_completed',
  'campaign.deletion_stuck',
  'erasure.resumed',
  'usage_report.exported',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const ACTOR_TYPES = ['user', 'admin', 'system', 'operator'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const OUTCOMES = ['allowed', 'denied', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const ALERT_KINDS = [
  'campaign_deletion_stuck',
  'account_erasure_stuck',
  'job_burst',
  'provider_auth_spike',
  'admin_role_changed',
  'reservation_inconsistency',
  'key_unseal_failed',
  'keys_disabled_all',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const MAX_COUNT_KEYS = 10;

const ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);
const KINDS: ReadonlySet<string> = new Set(ALERT_KINDS);

export const isAuditAction = (value: string): value is AuditAction => ACTIONS.has(value);
export const isAlertKind = (value: string): value is AlertKind => KINDS.has(value);

/** `counts` is an object of integers only with at most ten keys; anything else could carry a value or content. */
export function assertCounts(counts: Readonly<Record<string, number>>): void {
  const entries = Object.entries(counts);
  if (entries.length > MAX_COUNT_KEYS)
    throw new TypeError(`alert counts take at most ${String(MAX_COUNT_KEYS)} keys`);
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key))
      throw new TypeError('alert count keys are short snake_case names');
    if (!Number.isSafeInteger(value)) throw new TypeError('alert counts are integers');
  }
}

/** One open alert per kind and subject. */
export const dedupeKeyOf = (kind: AlertKind, subjectUserId: string | null): string =>
  `${kind}:${subjectUserId ?? '-'}`;
