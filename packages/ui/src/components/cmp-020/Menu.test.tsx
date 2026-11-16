// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './index';

afterEach(cleanup);

function setup(onSelect = vi.fn()) {
  const items: MenuItem[] = [
    { id: 'edit', label: 'Edit', onSelect },
    { id: 'archive', label: 'Archive', disabled: true, onSelect },
    { id: 'delete', label: 'Delete', destructive: true },
  ];
  return render(<Menu label="Actions for Spring" trigger="Actions" items={items} header={<p>Maya</p>} />);
}

describe('CMP-020 Menu', () => {
  it('trigger exposes aria-haspopup=menu and aria-expanded; items are menuitems', async () => {
    const { container } = setup();
    const trigger = screen.getByRole('button', { name: 'Actions for Spring' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Actions for Spring' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('opens with ArrowDown on the first item and ArrowUp on the last; arrows skip disabled and wrap', async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole('button', { name: 'Actions for Spring' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  });

  it('Escape closes and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole('button', { name: 'Actions for Spring' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('selecting an item calls onSelect, closes and returns focus; disabled item does nothing', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    setup(onSelect);
    const trigger = screen.getByRole('button', { name: 'Actions for Spring' });
    await user.click(trigger);
    const archive = screen.getByRole('menuitem', { name: 'Archive' });
    expect(archive).toHaveAttribute('aria-disabled', 'true');
    await user.click(archive);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on outside press and on Tab; clicking the trigger again toggles', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole('button', { name: 'Actions for Spring' });
    await user.click(trigger);
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(trigger);
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('defaultOpen with initialFocus focuses the first item', () => {
    render(<Menu label="A" trigger="A" items={[{ id: 'x', label: 'X' }]} defaultOpen initialFocus />);
    expect(screen.getByRole('menuitem', { name: 'X' })).toHaveFocus();
  });
});

describe('CMP-020 Menu placement and hover look', () => {
  it('on a phone viewport the open menu is fixed to the viewport just under a trigger inside a narrow container', () => {
    const sheet = document.createElement('style');
    sheet.textContent = '[role=menu]{position:fixed}'; // what max-md:fixed resolves to on a phone
    document.head.append(sheet);
    try {
      render(
        <div style={{ width: 120 }}>
          <Menu label="Row" trigger="Row" items={[{ id: 'x', label: 'X' }]} defaultOpen />
        </div>,
      );
      const menu = screen.getByRole('menu');
      expect(menu.className).toContain('max-md:fixed');
      expect(menu.style.top).toMatch(/px$/);
    } finally {
      sheet.remove();
    }
  });

  it('previewHover renders the hover look', () => {
    render(<Menu label="A" trigger="A" items={[{ id: 'x', label: 'X', previewHover: true }]} defaultOpen />);
    expect(screen.getByRole('menuitem', { name: 'X' })).toHaveAttribute('data-state', 'hover');
  });
});
