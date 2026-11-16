import type { Alert, AlertKind } from '@shroomap/contracts';
import type { BadgeVariant } from '@shroomap/ui/cmp-007';
import type { IconName } from '@shroomap/ui/icons';

/** SCREEN-014 copy (UI-UX §7 frame text, §8). Alerts carry user IDs and counts only, never an email. */
export const SCREEN_014_COPY = {
  title: 'Alerts',
  description: 'Things that need an administrator. Alerts show user IDs only.',
  listLabel: 'Alerts',
  acknowledge: 'Acknowledge',
  acknowledged: 'Acknowledged',
  acknowledgedToast: 'Alert acknowledged.',
  loading: 'Loading alerts',
  emptyTitle: 'No alerts',
  emptyBody: 'Stuck deletions, unusual usage and role changes appear here.',
  showMore: 'Show more',
  unavailableTitle: 'This page is not available.',
} as const;

export interface AlertPresentation {
  icon: IconName;
  tone: 'text-destructive' | 'text-warning' | 'text-info';
  badge: { variant: BadgeVariant; label: string };
  title: string;
  body: string;
}

/** `u_c07e…9b30`: a user ID shortened to its first and last four characters. */
export function shortUserId(id: string | null): string {
  if (!id) return 'An account';
  const bare = id.replace(/-/g, '');
  return bare.length > 10 ? `u_${bare.slice(0, 4)}…${bare.slice(-4)}` : `u_${bare}`;
}

const count = (counts: Alert['counts'], key: string): number | null => {
  const value = counts[key];
  return typeof value === 'number' ? value : null;
};

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

const NEEDS_ACTION = { variant: 'destructive', label: 'Needs action' } as const;
const CHECK = { variant: 'warning', label: 'Check' } as const;
const NOTICE = { variant: 'info', label: 'Notice' } as const;

function stuckBody(who: string, counts: Alert['counts']): string {
  const left = count(counts, 'remaining_objects');
  const attempts = count(counts, 'attempts');
  const objects =
    left === null ? 'Stored objects could not be removed' : `${plural(left, 'stored object', 'stored objects')} could not be removed`;
  const tries = attempts === null ? '' : ` after ${plural(attempts, 'attempt', 'attempts')}`;
  return `${who}: ${objects}${tries}. It keeps retrying. Check storage access.`;
}

/** What an alert says. An unknown kind still renders, as a notice naming nothing sensitive. */
export function presentAlert(alert: Alert): AlertPresentation {
  const who = shortUserId(alert.subjectUserId);
  const c = alert.counts;
  const kind: AlertKind = alert.kind;
  switch (kind) {
    case 'account_erasure_stuck':
      return { icon: 'circle-alert', tone: 'text-destructive', badge: NEEDS_ACTION, title: 'Account erasure is stuck', body: stuckBody(who, c) };
    case 'campaign_deletion_stuck':
      return { icon: 'circle-alert', tone: 'text-destructive', badge: NEEDS_ACTION, title: 'Campaign deletion is stuck', body: stuckBody(who, c) };
    case 'job_burst': {
      const jobs = count(c, 'jobs');
      const minutes = count(c, 'window_minutes');
      const limit = count(c, 'limit');
      const made = jobs === null ? 'created many provider jobs' : `created ${plural(jobs, 'provider job', 'provider jobs')}`;
      const within = minutes === null ? '' : ` in ${plural(minutes, 'minute', 'minutes')}`;
      return { icon: 'triangle-alert', tone: 'text-warning', badge: CHECK, title: 'Unusual job volume', body: `${who} ${made}${within}${limit === null ? '' : ` (limit ${String(limit)})`}.` };
    }
    case 'provider_auth_spike': {
      const failures = count(c, 'failures');
      const minutes = count(c, 'window_minutes');
      return { icon: 'triangle-alert', tone: 'text-warning', badge: CHECK, title: 'Provider key failures are rising', body: `${failures === null ? 'Several' : String(failures)} provider calls were refused for ${who}${minutes === null ? '' : ` in ${plural(minutes, 'minute', 'minutes')}`}. Check the key.` };
    }
    case 'admin_role_changed':
      return { icon: 'info', tone: 'text-info', badge: NOTICE, title: 'Administrator role changed', body: `The administrator role of ${who} was changed.` };
    case 'reservation_inconsistency':
      return { icon: 'triangle-alert', tone: 'text-warning', badge: CHECK, title: 'Usage reservation mismatch', body: `A usage reservation for ${who} does not match its jobs. It is being reconciled.` };
    case 'key_unseal_failed':
      return { icon: 'circle-alert', tone: 'text-destructive', badge: NEEDS_ACTION, title: 'A stored key could not be opened', body: `The key of ${who} could not be opened. Check the encryption configuration.` };
    case 'keys_disabled_all':
      return { icon: 'circle-alert', tone: 'text-destructive', badge: NEEDS_ACTION, title: 'All provider keys were disabled', body: `${who}: every provider key was disabled after repeated refusals.` };
    default:
      return { icon: 'info', tone: 'text-info', badge: NOTICE, title: 'Administrator alert', body: `${who}: see the audit trail.` };
  }
}

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** `Today, 08:41`, `Yesterday, 17:02`, else `12 Nov, 09:30` (the browser's time zone). */
export function formatRaised(instant: string, now: Date = new Date()): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : DAY.format(at);
  return `${day}, ${TIME.format(at)}`;
}
