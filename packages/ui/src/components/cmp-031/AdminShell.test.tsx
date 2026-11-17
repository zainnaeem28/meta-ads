// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminShell, ADMIN_NAV, formatAlertCount } from './index';
import type { AdminShellProps } from './index';
import { AdminShellDemo } from './gallery-demos';

afterEach(cleanup);

const shell = (props: Partial<AdminShellProps> = {}) =>
  render(
    <AdminShell path="/admin/accounts" pageName="Accounts" {...props}>
      <h1>Accounts</h1>
    </AdminShell>,
  );

describe('CMP-031 AdminShell', () => {
  it('is the admin portal with the portal tag and the top rule', () => {
    const { container } = shell();
    expect(container.firstElementChild).toHaveAttribute('data-portal', 'admin');
    expect(screen.getByText('Administration')).toHaveAttribute('data-portal-tag');
    expect(screen.getByRole('banner').className).toContain('border-t-primary');
  });

  it('lists the five admin items in order, marks the current one, Back to workspace in the foot', () => {
    shell({ path: '/admin/usage', layout: 'sidebar' });
    const links = within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Accounts', '/admin/accounts'],
      ['Invitations', '/admin/invitations'],
      ['Usage report', '/admin/usage'],
      ['Alerts', '/admin/alerts'],
      ['Settings', '/admin/settings'],
      ['Back to workspace', '/campaigns'],
    ]);
    expect(links.map((l) => l.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'page',
      null,
      null,
      null,
    ]);
    expect(links.at(-1)?.className).toContain('mt-auto');
  });

  it('shows the unacknowledged count on Alerts only, with an accessible text, capped at 99+', () => {
    const { rerender } = shell({ alertCount: 0 });
    expect(document.querySelector('[data-alert-count]')).toBeNull();
    rerender(
      <AdminShell path="/admin/accounts" alertCount={3}>
        <p />
      </AdminShell>,
    );
    const alerts = screen.getByRole('link', { name: /^Alerts/ });
    expect(alerts).toHaveTextContent('3');
    expect(alerts).toHaveTextContent('3 unacknowledged');
    expect(document.querySelectorAll('[data-alert-count]')).toHaveLength(1);
    rerender(
      <AdminShell path="/admin/accounts" alertCount={140}>
        <p />
      </AdminShell>,
    );
    expect(screen.getByText('99+')).toBeInTheDocument();
    expect(formatAlertCount(99)).toBe('99');
  });

  it('collapses the count to a dot on the rail, keeping the text for assistive tech', () => {
    shell({ layout: 'rail', alertCount: 3 });
    const badge = document.querySelector('[data-alert-count]') as HTMLElement;
    expect(badge.className).toContain('size-2');
    expect(within(badge).getByText('3 unacknowledged')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to workspace' })).toHaveAttribute(
      'title',
      'Back to workspace',
    );
  });

  it('tab bar uses the short labels and has no foot link', () => {
    shell({ layout: 'tabbar' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Invites' })).toHaveAttribute(
      'title',
      'Invitations',
    );
    expect(within(nav).getByText('Back to workspace').closest('a')?.className).toContain('hidden');
  });

  it('renders a disabled item as a non-link', () => {
    shell({ previewDisabled: 'usage', layout: 'sidebar' });
    const item = document.querySelector('[aria-disabled=true]');
    expect(item).toHaveTextContent('Usage report');
    expect(item).not.toHaveAttribute('href');
    expect(item).not.toHaveAttribute('tabindex');
  });

  it('can preview hover and focus on an item', () => {
    shell({ previewHover: 'settings', previewFocus: 'invitations', layout: 'sidebar' });
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('data-state', 'hover');
    expect(screen.getByRole('link', { name: 'Invitations' }).className).toContain('outline-2');
  });

  it('unavailable (403): no navigation, explanation and a way back', () => {
    shell({ unavailable: true });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Administration is not available' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Back to workspace' })[0]).toHaveAttribute(
      'href',
      '/campaigns',
    );
  });

  it('has the skip link first, landmarks and no axe violations in every layout and state', async () => {
    for (const props of [
      { layout: 'auto', alertCount: 3 },
      { layout: 'rail', alertCount: 3 },
      { layout: 'tabbar', alertCount: 3 },
      { layout: 'sidebar' },
      { unavailable: true },
    ] as const) {
      const { container, unmount } = shell({ userName: 'Sam', ...props });
      expect(container.querySelector('a, button')).toHaveTextContent('Skip to content');
      expect(screen.getByRole('banner')).toBeInTheDocument();
      expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
      expect((await axe.run(container)).violations).toEqual([]);
      unmount();
    }
  });

  it('sets the document title and noindex', () => {
    const { unmount } = shell();
    expect(document.title).toBe('Accounts · ShrooMap');
    expect(document.head.querySelector('meta[name=robots]')).toHaveAttribute('content', 'noindex');
    unmount();
  });

  it('avatar menu: switch to workspace, account link, sign out', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onSignOut = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    shell({ onNavigate, onSignOut, userName: 'Sam' });
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByText('Signed in as Administrator')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Switch to workspace',
      'Account and security',
      'Sign out',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Switch to workspace' }));
    expect(onNavigate).toHaveBeenCalledWith('/campaigns');
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Account and security' }));
    expect(open).toHaveBeenCalledWith('/account', '_blank', 'noopener,noreferrer');
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
    open.mockRestore();
  });

  it('defaults navigation to a full page load', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { assign }, configurable: true });
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Switch to workspace' }));
    expect(assign).toHaveBeenCalledWith('/campaigns');
    Object.defineProperty(window, 'location', { value: original, configurable: true });
  });

  it('hosts toasts and dismisses them through the demo', async () => {
    const user = userEvent.setup();
    render(<AdminShellDemo toasts={[{ id: 'a', variant: 'success', message: 'Saved' }]} />);
    expect(within(screen.getByRole('status')).getByText('Saved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close notification' }));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('exports five items with admin routes', () => {
    expect(ADMIN_NAV.map((i) => i.href)).toEqual([
      '/admin/accounts',
      '/admin/invitations',
      '/admin/usage',
      '/admin/alerts',
      '/admin/settings',
    ]);
  });
});
