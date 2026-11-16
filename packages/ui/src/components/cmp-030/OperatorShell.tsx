'use client';

import type { ReactNode } from 'react';
import { Icon } from '../../icons';
import { LogoLink } from '../cmp-001';
import { Badge } from '../cmp-007';
import { ToastRegion, type ToastRegionProps } from '../cmp-012';
import { Menu, type MenuItem } from '../cmp-020';
import type { KeyState } from './key-state';
import { OPERATOR_NAV, PROVIDER_KEYS_HREF, currentItem, type NavItem } from './nav-items';
import { useShellDocument } from './useShellDocument';

export const SHELL_ROLES = ['user', 'admin'] as const;
export type ShellRole = (typeof SHELL_ROLES)[number];
/** `auto` follows the viewport (tab bar, rail from 768 px, sidebar from 1024 px); the others pin one form for the gallery. */
export type ShellLayout = 'auto' | 'sidebar' | 'rail' | 'tabbar';

export interface OperatorShellProps {
  role: ShellRole;
  /** Route of the current page; marks the nav item `aria-current="page"`. */
  path: string;
  /** Page name for the document title ("Page · ShrooMap"). */
  pageName?: string;
  /** Display name in the avatar menu header. */
  userName?: string;
  keyState?: KeyState;
  children: ReactNode;
  toasts?: ToastRegionProps['toasts'];
  onDismissToast?: ToastRegionProps['onDismiss'];
  /** Menu navigation (client router); defaults to a full page load. */
  onNavigate?: (href: string) => void;
  onSignOut?: () => void;
  /** Provider-hosted account page; opens in a new tab. */
  accountUrl?: string;
  adminHref?: string;
  layout?: ShellLayout;
  /** Gallery only: lay the shell out inside its frame instead of the viewport, and open the avatar menu. */
  embedded?: boolean;
  menuOpen?: boolean;
  /** Gallery only: preview a nav item's hover look. */
  previewHover?: string;
}

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

const NAV_LAYOUT: Record<ShellLayout, string> = {
  auto: 'fixed inset-x-0 bottom-0 h-tabbar flex-row md:static md:inset-x-auto md:bottom-auto md:h-auto md:self-stretch md:w-rail md:flex-col md:border-r md:border-t-0 lg:w-sidebar',
  sidebar: 'w-sidebar flex-col border-r',
  rail: 'w-rail flex-col border-r',
  tabbar: 'order-last h-tabbar w-full flex-row border-t',
};

function itemClasses(layout: ShellLayout, current: boolean, hover: boolean): string {
  const shape =
    layout === 'tabbar'
      ? 'flex-1 flex-col justify-center gap-1 border-t-3 px-1 text-caption'
      : layout === 'rail'
        ? 'justify-center border-l-3 px-2 min-h-control'
        : layout === 'sidebar'
          ? 'gap-3 border-l-3 px-4 min-h-control text-ui'
          : 'flex-1 flex-col justify-center gap-1 border-t-3 px-1 text-caption md:flex-none md:flex-row md:justify-center md:gap-3 md:border-l-3 md:border-t-0 md:px-2 md:text-ui md:min-h-control lg:justify-start lg:px-4';
  const marker = current ? 'border-primary bg-sidebar-accent font-semibold text-sidebar-accent-foreground' : `border-transparent text-sidebar-foreground hover:bg-accent${hover ? ' bg-accent' : ''}`;
  return `flex items-center ${shape} ${marker} ${FOCUS}`;
}

function labelClasses(layout: ShellLayout): string {
  if (layout === 'rail') return 'sr-only';
  if (layout === 'auto') return 'md:max-lg:sr-only';
  return '';
}

function NavLink({ item, layout, current, hover }: { item: NavItem; layout: ShellLayout; current: boolean; hover: boolean }) {
  const collapsed = layout === 'rail';
  const label = <span className={labelClasses(layout)}>{item.label}</span>;
  if (item.disabled) {
    return (
      <span aria-disabled="true" data-state="disabled" className={`${itemClasses(layout, false, false)} cursor-not-allowed text-disabled-foreground`}>
        <Icon name={item.icon} size={20} />
        {label}
      </span>
    );
  }
  return (
    <a
      href={item.href}
      aria-current={current ? 'page' : undefined}
      data-state={current ? 'current' : hover ? 'hover' : 'default'}
      title={collapsed ? item.label : undefined}
      className={itemClasses(layout, current, hover)}
    >
      <Icon name={item.icon} size={20} />
      {label}
    </a>
  );
}

/** CMP-030: operator shell. Header (56 px), one `nav aria-label="Main"` that is the tab bar under 768 px, the icon rail to 1023 px and the sidebar above, `main`, skip link first, key badge, avatar menu and the toast region. */
export function OperatorShell({
  role,
  path,
  pageName,
  userName,
  keyState = 'ok',
  children,
  toasts = [],
  onDismissToast,
  onNavigate,
  onSignOut,
  accountUrl = '/account',
  adminHref = '/admin/accounts',
  layout = 'auto',
  embedded = false,
  menuOpen = false,
  previewHover,
}: OperatorShellProps) {
  useShellDocument(pageName);
  const go = (href: string) => (onNavigate ? onNavigate(href) : window.location.assign(href));
  const current = currentItem(OPERATOR_NAV, path);
  const signedIn = role === 'admin' ? 'Signed in as Administrator' : 'Signed in as Operator';

  const items: MenuItem[] = [
    { id: 'keys', label: 'Provider keys', onSelect: () => go(PROVIDER_KEYS_HREF) },
    ...(role === 'admin' ? [{ id: 'admin', label: 'Switch to administration', onSelect: () => go(adminHref) }] : []),
    { id: 'account', label: 'Account and security', onSelect: () => window.open(accountUrl, '_blank', 'noopener,noreferrer') },
    { id: 'sign-out', label: 'Sign out', onSelect: () => onSignOut?.() },
  ];

  const frame = `@container ${embedded ? 'relative transform-gpu flex h-160 flex-col overflow-hidden' : 'flex min-h-screen flex-col'}`;
  return (
    <div data-shell="operator" data-role={role} data-layout={layout} className={`${frame} bg-background text-foreground`}>
      <a
        href="#main-content"
        className={`absolute left-2 top-2 z-50 -translate-y-20 rounded-md bg-card px-4 py-2 text-ui font-semibold text-foreground shadow-md focus:translate-y-0 ${FOCUS}`}
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 flex h-header shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 md:px-6">
        <LogoLink href="/campaigns" className="shrink-0 @max-xs:hidden" />
        <LogoLink href="/campaigns" logo={{ form: 'mark', size: 32 }} className="shrink-0 @xs:hidden" />
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          {keyState !== 'ok' ? (
            <a href={PROVIDER_KEYS_HREF} data-key-badge={keyState} className={`rounded-full ${FOCUS}`}>
              <Badge variant={keyState === 'missing' ? 'warning' : 'destructive'}>
                {keyState === 'missing' ? 'Add provider keys' : 'Key disabled'}
              </Badge>
            </a>
          ) : null}
          <Menu
            label="Account menu"
            align="end"
            defaultOpen={menuOpen}
            header={
              <>
                <span className="block text-caption text-muted-foreground">{signedIn}</span>
                {userName ? <span className="block font-semibold">{userName}</span> : null}
              </>
            }
            trigger={<Icon name="circle-user" size={20} />}
            items={items}
          />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Main"
          className={`z-20 flex shrink-0 gap-1 border-sidebar-border bg-sidebar p-0 md:gap-1 md:p-2 ${NAV_LAYOUT[layout]}`}
        >
          {OPERATOR_NAV.map((item) => (
            <NavLink key={item.id} item={item} layout={layout} current={current?.id === item.id} hover={previewHover === item.id} />
          ))}
        </nav>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 pb-24 outline-none md:px-6 md:pb-6 lg:px-8">
          {children}
        </main>
      </div>
      <ToastRegion toasts={toasts} onDismiss={onDismissToast ?? (() => undefined)} />
    </div>
  );
}
