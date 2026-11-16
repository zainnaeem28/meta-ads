// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatorShell, currentItem, deriveKeyState, OPERATOR_NAV } from './index';
import type { OperatorShellProps } from './index';
import { ShellDemo } from './gallery-demos';

afterEach(cleanup);

const shell = (props: Partial<OperatorShellProps> = {}) =>
  render(
    <OperatorShell role="user" path="/campaigns" pageName="Campaigns" {...props}>
      <h1>Campaigns</h1>
    </OperatorShell>,
  );

describe('CMP-030 OperatorShell', () => {
  it('has the skip link first, header, Main nav and main landmarks, and no axe violations', async () => {
    const { container } = shell({ userName: 'Alex' });
    const first = container.querySelector('a, button');
    expect(first).toHaveTextContent('Skip to content');
    expect(first).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('lists the three items in order and marks the current one', () => {
    shell({ path: '/campaigns/new' });
    const links = within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Campaigns', '/campaigns'],
      ['New brief', '/campaigns/new'],
      ['Provider keys', '/settings/provider-keys'],
    ]);
    expect(links.map((l) => l.getAttribute('aria-current'))).toEqual([null, 'page', null]);
  });

  it('keeps the label as the accessible name in the collapsed rail', () => {
    shell({ layout: 'rail' });
    const link = screen.getByRole('link', { name: 'Campaigns' });
    expect(link).toHaveAttribute('title', 'Campaigns');
  });

  it('sets the document title and noindex, and restores them on unmount', () => {
    document.title = 'before';
    const { unmount } = shell();
    expect(document.title).toBe('Campaigns · ShrooMap');
    expect(document.head.querySelector('meta[name=robots]')).toHaveAttribute('content', 'noindex');
    unmount();
    expect(document.title).toBe('before');
    expect(document.head.querySelector('meta[name=robots]')).toBeNull();
  });

  it('reuses an existing robots tag and puts it back', () => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'index';
    document.head.appendChild(meta);
    const { unmount } = shell();
    expect(meta.content).toBe('noindex');
    unmount();
    expect(meta.content).toBe('index');
    meta.remove();
  });

  it('shows the key badge as a link to the key screen only when a key is missing or disabled', () => {
    const { rerender } = shell({ keyState: 'ok' });
    expect(screen.queryByText('Add provider keys')).toBeNull();
    const props = { role: 'user', path: '/campaigns' } as const;
    rerender(<OperatorShell {...props} keyState="missing"><p /></OperatorShell>);
    expect(screen.getByRole('link', { name: 'Add provider keys' })).toHaveAttribute('href', '/settings/provider-keys');
    rerender(<OperatorShell {...props} keyState="disabled"><p /></OperatorShell>);
    const badge = screen.getByRole('link', { name: 'Key disabled' });
    expect(badge).toHaveAttribute('data-key-badge', 'disabled');
    expect(badge.querySelector('[data-variant=destructive]')).not.toBeNull();
  });

  it('avatar menu: admin sees the switch, user does not; actions fire', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onSignOut = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    shell({ role: 'admin', onNavigate, onSignOut, userName: 'Sam' });
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByText('Signed in as Administrator')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Provider keys', 'Switch to administration', 'Account and security', 'Sign out',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Switch to administration' }));
    expect(onNavigate).toHaveBeenCalledWith('/admin/accounts');
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Provider keys' }));
    expect(onNavigate).toHaveBeenLastCalledWith('/settings/provider-keys');
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Account and security' }));
    expect(open).toHaveBeenCalledWith('/account', '_blank', 'noopener,noreferrer');
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
    open.mockRestore();
  });

  it('operator menu has no administration switch; Escape closes it and returns focus', async () => {
    const user = userEvent.setup();
    shell();
    const trigger = screen.getByRole('button', { name: 'Account menu' });
    await user.click(trigger);
    expect(screen.getByText('Signed in as Operator')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Switch to administration' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('defaults navigation to a full page load', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { assign }, configurable: true });
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Provider keys' }));
    expect(assign).toHaveBeenCalledWith('/settings/provider-keys');
    Object.defineProperty(window, 'location', { value: original, configurable: true });
  });

  it('hosts toasts in the live regions and dismisses through the demo', async () => {
    const user = userEvent.setup();
    render(<ShellDemo toasts={[{ id: 'a', variant: 'success', message: 'Saved' }]} />);
    expect(within(screen.getByRole('status')).getByText('Saved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close notification' }));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('opens focus on nav links with Tab after the skip link', async () => {
    const user = userEvent.setup();
    shell();
    await user.tab();
    expect(screen.getByText('Skip to content')).toHaveFocus();
  });
});

describe('deriveKeyState and currentItem', () => {
  const k = (configured: boolean, status: 'active' | 'untested' | 'disabled' | null) => ({ configured, status });
  it('maps the API-010 list', () => {
    expect(deriveKeyState(undefined)).toBe('ok');
    expect(deriveKeyState([])).toBe('ok');
    expect(deriveKeyState([k(true, 'active'), k(true, 'untested')])).toBe('ok');
    expect(deriveKeyState([k(false, null), k(true, 'active')])).toBe('missing');
    expect(deriveKeyState([k(true, 'disabled'), k(false, null)])).toBe('disabled');
  });
  it('picks the longest matching route', () => {
    expect(currentItem(OPERATOR_NAV, '/campaigns/new')?.id).toBe('new-brief');
    expect(currentItem(OPERATOR_NAV, '/campaigns/abc/brief')?.id).toBe('campaigns');
    expect(currentItem(OPERATOR_NAV, '/other')).toBeUndefined();
  });
});
