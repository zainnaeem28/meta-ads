import type { Invitation } from '@shroomap/contracts';
import type { InvitationStateView } from './copy';

const DAY = 86_400_000;

const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "in 6 days" / "9 days ago" for an instant, relative to `now`. */
export function relativeDays(iso: string, now: number): string {
  const diff = new Date(iso).getTime() - now;
  const days = Math.floor(Math.abs(diff) / DAY);
  if (diff >= 0) {
    if (days >= 1) return `in ${unit(days, 'day')}`;
    const hours = Math.floor(diff / 3_600_000);
    return hours >= 1 ? `in ${unit(hours, 'hour')}` : 'in less than an hour';
  }
  if (days >= 1) return `${unit(days, 'day')} ago`;
  const hours = Math.floor(-diff / 3_600_000);
  return hours >= 1 ? `${unit(hours, 'hour')} ago` : 'just now';
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", otherwise the calendar date. */
export function askedLabel(iso: string, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso).getTime())) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Status badge of an invitation; a send failure on a live invitation reads "Email not delivered". */
export function invitationView(invitation: Pick<Invitation, 'state' | 'sendState'>): InvitationStateView {
  switch (invitation.state) {
    case 'invited':
      return invitation.sendState === 'send_failed'
        ? { label: 'Email not delivered', variant: 'warning', icon: 'triangle-alert' }
        : { label: 'Invited', variant: 'info', icon: 'mail' };
    case 'expired':
      return { label: 'Expired', variant: 'warning', icon: 'clock' };
    case 'accepted':
      return { label: 'Accepted', variant: 'success', icon: 'circle-check' };
    default:
      return { label: 'Revoked', variant: 'neutral', icon: 'ban' };
  }
}

/** Who invited: an administrator's user ID (never an email outside the admin screens), or the system. */
export const invitedByLabel = (id: string | null): string => (id ? `Admin ${id.slice(0, 8)}` : 'System');
