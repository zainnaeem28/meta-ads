import type { IconName } from '../../icons';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Only campaign stage tabs use this; the operator shell items are always enabled. */
  disabled?: boolean;
}

/** Operator navigation, in order (UI-UX §3). */
export const OPERATOR_NAV: readonly NavItem[] = [
  { id: 'campaigns', label: 'Campaigns', href: '/campaigns', icon: 'clapperboard' },
  { id: 'new-brief', label: 'New brief', href: '/campaigns/new', icon: 'square-pen' },
  {
    id: 'provider-keys',
    label: 'Provider keys',
    href: '/settings/provider-keys',
    icon: 'key-round',
  },
];

export const PROVIDER_KEYS_HREF = '/settings/provider-keys';

/** The item for the current path: the longest matching href wins so `/campaigns/new` is not also "Campaigns". */
export function currentItem(items: readonly NavItem[], path: string): NavItem | undefined {
  const matches = items.filter((i) => path === i.href || path.startsWith(`${i.href}/`));
  return matches.sort((a, b) => b.href.length - a.href.length)[0];
}
