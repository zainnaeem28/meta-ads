'use client';

import type { ReactNode } from 'react';
import { Icon } from '../../icons';
import { LogoLink } from '../cmp-001';
import { ToastRegion, type ToastRegionProps } from '../cmp-012';
import { Menu, type MenuItem } from '../cmp-020';
import { currentItem } from '../cmp-030/nav-items';
import type { ShellLayout } from '../cmp-030/OperatorShell';
import { useShellDocument } from '../cmp-030/useShellDocument';
import { ADMIN_NAV, WORKSPACE_HREF, formatAlertCount, type AdminNavItem } from './nav-items';

export interface AdminShellProps {
  /** Route of the current page; marks the nav item `aria-current="page"`. */
  path: string;
  pageName?: string;
  userName?: string;
  /** Unacknowledged alerts (API-125); 0 or undefined shows no badge. */
  alertCount?: number;
  /** A non-admin got 403: the nav is withheld and the unavailable state replaces the page. */
  unavailable?: boolean;
  children?: ReactNode;
  toasts?: ToastRegionProps['toasts'];
  onDismissToast?: ToastRegionProps['onDismiss'];
  onNavigate?: (href: string) => void;
  onSignOut?: () => void;
  accountUrl?: string;
  workspaceHref?: string;
  layout?: ShellLayout;
  /** Gallery only: lay the shell out inside its frame instead of the viewport, and open the avatar menu. */
  embedded?: boolean;
  menuOpen?: boolean;
  /** Gallery only: preview one nav item's hover, disabled or focus look (by id). */
  previewHover?: string;
  previewDisabled?: string;
  previewFocus?: string;
}

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const FOCUS_SHOWN = 'outline-2 outline-offset-2 outline-ring';

const NAV_LAYOUT: Record<ShellLayout, string> = {
  auto: 'fixed inset-x-0 bottom-0 h-tabbar flex-row md:static md:inset-x-auto md:bottom-auto md:h-auto md:self-stretch md:w-rail md:flex-col md:border-r md:border-t-0 lg:w-sidebar',
  sidebar: 'w-sidebar flex-col border-r',
  rail: 'w-rail flex-col border-r',
  tabbar: 'order-last h-tabbar w-full flex-row border-t',
};

function itemClasses(layout: ShellLayout, state: 'current' | 'hover' | 'default' | 'disabled', focus: boolean): string {
  const shape =
    layout === 'tabbar'
      ? 'relative flex-1 flex-col justify-center gap-1 border-t-3 px-1 text-caption'
      : layout === 'rail'
        ? 'relative justify-center border-l-3 px-2 min-h-control'
        : layout === 'sidebar'
          ? 'gap-3 border-l-3 px-4 min-h-control text-ui'
          : 'relative flex-1 flex-col justify-center gap-1 border-t-3 px-1 text-caption md:flex-none md:flex-row md:justify-center md:gap-3 md:border-l-3 md:border-t-0 md:px-2 md:text-ui md:min-h-control lg:justify-start lg:px-4';
  const marker =
    state === 'disabled'
      ? 'border-transparent text-disabled-foreground cursor-not-allowed'
      : state === 'current'
        ? 'border-primary bg-sidebar-accent font-semibold text-sidebar-accent-foreground'
        : `border-transparent text-sidebar-foreground hover:bg-accent${state === 'hover' ? ' bg-accent' : ''}`;
  return `flex items-center ${shape} ${marker} ${FOCUS}${focus ? ` ${FOCUS_SHOWN}` : ''}`;
}

function labelClasses(layout: ShellLayout): string {
  if (layout === 'rail') return 'sr-only';
  if (layout === 'auto') return 'md:max-lg:sr-only';
  return '';
}

/** Count badge in the sidebar and tab bar, a dot on the rail (UI-UX §3). The count is also the accessible text. */
function AlertCount({ count, layout }: { count: number; layout: ShellLayout }) {
  const text = `${count} unacknowledged`;
  const badge =
    layout === 'tabbar'
      ? 'absolute left-1/2 top-1 ml-1.5 min-w-4 px-1 text-caption'
      : layout === 'auto'
        ? 'absolute left-1/2 top-1 ml-1.5 min-w-4 px-1 text-caption md:static md:ml-auto md:min-w-5 md:px-1.5 md:max-lg:absolute md:max-lg:right-1 md:max-lg:top-1 md:max-lg:left-auto md:max-lg:ml-0 md:max-lg:size-2 md:max-lg:min-w-0 md:max-lg:p-0'
        : layout === 'rail'
          ? 'absolute right-1 top-1 size-2 min-w-0 p-0'
          : 'ml-auto min-w-5 px-1.5 text-caption';
  const hideText = layout === 'rail' ? 'sr-only' : layout === 'auto' ? 'md:max-lg:sr-only' : '';
  return (
    <span data-alert-count={count} className={`grid place-items-center rounded-full bg-destructive font-semibold tabular-nums text-destructive-foreground ${badge}`}>
      <span aria-hidden="true" className={hideText}>{formatAlertCount(count)}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

function NavLink({ item, layout, current, hover, focus, disabled, alertCount }: { item: AdminNavItem; layout: ShellLayout; current: boolean; hover: boolean; focus: boolean; disabled: boolean; alertCount: number }) {
  const collapsed = layout === 'rail';
  const short = item.short && (layout === 'tabbar' || layout === 'auto');
  const label =
    short && layout === 'tabbar' ? (
      <span>{item.short}</span>
    ) : short ? (
      <>
        <span className="md:hidden">{item.short}</span>
        <span className={`max-md:hidden ${labelClasses(layout)}`}>{item.label}</span>
      </>
    ) : (
      <span className={labelClasses(layout)}>{item.label}</span>
    );
  const showCount = item.id === 'alerts' && alertCount > 0;
  if (disabled) {
    return (
      <span aria-disabled="true" data-state="disabled" className={itemClasses(layout, 'disabled', false)}>
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
      title={collapsed || short ? item.label : undefined}
      className={itemClasses(layout, current ? 'current' : hover ? 'hover' : 'default', focus)}
    >
      <Icon name={item.icon} size={20} />
      {label}
      {showCount ? <AlertCount count={alertCount} layout={layout} /> : null}
    </a>
  );
}

/** CMP-031: administration shell. The CMP-030 grid under `data-portal="admin"` (navy primary) with a 3 px top rule, the "Administration" portal tag, five admin items with the unacknowledged-alert badge, and "Back to workspace" in the sidebar foot. */
export function AdminShell({
  path,
  pageName,
  userName,
  alertCount = 0,
  unavailable = false,
  children,
  toasts = [],
  onDismissToast,
  onNavigate,
  onSignOut,
  accountUrl = '/account',
  workspaceHref = WORKSPACE_HREF,
  layout = 'auto',
  embedded = false,
  menuOpen = false,
  previewHover,
  previewDisabled,
  previewFocus,
}: AdminShellProps) {
  useShellDocument(pageName);
  const go = (href: string) => (onNavigate ? onNavigate(href) : window.location.assign(href));
  const current = currentItem(ADMIN_NAV, path);

  const items: MenuItem[] = [
    { id: 'workspace', label: 'Switch to workspace', onSelect: () => go(workspaceHref) },
    { id: 'account', label: 'Account and security', onSelect: () => window.open(accountUrl, '_blank', 'noopener,noreferrer') },
    { id: 'sign-out', label: 'Sign out', onSelect: () => onSignOut?.() },
  ];

  const frame = `@container ${embedded ? 'relative transform-gpu flex h-160 flex-col overflow-hidden' : 'flex min-h-screen flex-col'}`;
  const foot = `${itemClasses(layout, 'default', false)} mt-auto${layout === 'tabbar' ? ' hidden' : layout === 'auto' ? ' max-md:hidden' : ''}`;
  return (
    <div data-shell="admin" data-portal="admin" data-layout={layout} className={`${frame} bg-background text-foreground`}>
      <a
        href="#main-content"
        className={`absolute left-2 top-2 z-50 -translate-y-20 rounded-md bg-card px-4 py-2 text-ui font-semibold text-foreground shadow-md focus:translate-y-0 ${FOCUS}`}
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 flex h-header shrink-0 items-center justify-between gap-3 border-b border-t-3 border-border border-t-primary bg-card px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <LogoLink href="/admin/accounts" className="shrink-0 @max-xs:hidden" />
          <LogoLink href="/admin/accounts" logo={{ form: 'mark', size: 32 }} className="shrink-0 @xs:hidden" />
          <span data-portal-tag className="hidden rounded-sm border border-border-strong bg-primary-subtle px-2 py-0.5 text-caption font-semibold uppercase tracking-wide text-foreground md:inline">
            Administration
          </span>
        </div>
        <Menu
          label="Account menu"
          align="end"
          defaultOpen={menuOpen}
          header={
            <>
              <span className="block text-caption text-muted-foreground">Signed in as Administrator</span>
              {userName ? <span className="block font-semibold">{userName}</span> : null}
            </>
          }
          trigger={<Icon name="circle-user" size={20} />}
          items={items}
        />
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {unavailable ? null : (
          <nav aria-label="Main" className={`z-20 flex shrink-0 gap-1 border-sidebar-border bg-sidebar p-0 md:gap-1 md:p-2 ${NAV_LAYOUT[layout]}`}>
            {ADMIN_NAV.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                layout={layout}
                current={current?.id === item.id}
                hover={previewHover === item.id}
                focus={previewFocus === item.id}
                disabled={previewDisabled === item.id}
                alertCount={alertCount}
              />
            ))}
            <a href={workspaceHref} title={layout === 'rail' ? 'Back to workspace' : undefined} data-sidebar-foot className={foot}>
              <Icon name="arrow-left" size={20} />
              <span className={labelClasses(layout)}>Back to workspace</span>
            </a>
          </nav>
        )}
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 pb-24 outline-none md:px-6 md:pb-6 lg:px-8">
          {unavailable ? (
            <section data-state="unavailable" aria-labelledby="admin-unavailable" className="mx-auto flex max-w-prose flex-col items-start gap-3 py-12">
              <h1 id="admin-unavailable" className="text-h1 font-semibold">Administration is not available</h1>
              <p className="text-ui text-muted-foreground">Your account does not have administrator access. Ask an administrator if you need it.</p>
              <a href={workspaceHref} className={`rounded-md bg-primary px-4 py-2 text-ui font-semibold text-primary-foreground ${FOCUS}`}>
                Back to workspace
              </a>
            </section>
          ) : (
            children
          )}
        </main>
      </div>
      <ToastRegion toasts={toasts} onDismiss={onDismissToast ?? (() => undefined)} />
    </div>
  );
}
