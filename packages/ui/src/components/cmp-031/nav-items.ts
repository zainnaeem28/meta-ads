import type { NavItem } from '../cmp-030/nav-items';

export interface AdminNavItem extends NavItem {
  /** Shorter label for the tab bar (five items at 390 px). */
  short?: string;
}

/** Administration navigation, in order (UI-UX §3). */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  { id: 'accounts', label: 'Accounts', href: '/admin/accounts', icon: 'users' },
  { id: 'invitations', label: 'Invitations', short: 'Invites', href: '/admin/invitations', icon: 'mail-plus' },
  { id: 'usage', label: 'Usage report', short: 'Usage', href: '/admin/usage', icon: 'chart-column' },
  { id: 'alerts', label: 'Alerts', href: '/admin/alerts', icon: 'bell' },
  { id: 'settings', label: 'Settings', href: '/admin/settings', icon: 'settings' },
];

export const WORKSPACE_HREF = '/campaigns';

/** Count shown on the Alerts item; large counts are capped so the badge keeps its width. */
export function formatAlertCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}
