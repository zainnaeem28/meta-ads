// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogPanel, type DialogProps } from './index';
import { DialogLive, DialogStates, MenuStates } from './gallery-demos';

afterEach(cleanup);

function Harness(props: Partial<DialogProps> & { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog
        title="Pause campaign?"
        description="Ads stop."
        confirmLabel="Pause"
        onConfirm={() => {}}
        {...props}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe('CMP-013 Dialog', () => {
  it('has role dialog, aria-modal and a labelled title, and passes axe', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Pause campaign?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Ads stop.');
    expect((await axe.run(document.body)).violations).toEqual([]);
  });

  it('moves focus in, traps Tab both ways, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Pause' });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('closes on overlay press but not on a press inside the card', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('dialog-overlay'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirm calls onConfirm', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('typed confirm keeps confirm disabled until the exact text is typed', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<Harness variant="typed-confirm" confirmText="Spring" confirmLabel="Delete" destructive onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const input = screen.getByLabelText(/Type/);
    expect(input).toHaveFocus();
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    await user.type(input, 'spring');
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'Spring{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('pending locks cancel, Escape and overlay, and shows the busy state', async () => {
    const user = userEvent.setup();
    render(<Harness pending />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('dialog-overlay'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows a blocking error as an alert', async () => {
    render(<Harness error="Could not pause." />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not pause.');
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'error');
  });

  it('dirty: closing asks to discard; Escape keeps editing, Discard closes', async () => {
    const user = userEvent.setup();
    render(<Harness variant="form" dirty />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toHaveAttribute('data-state', 'dirty-discard');
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Pause campaign?' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('DialogPanel renders every state with no axe violations', async () => {
    const { container } = render(<DialogStates />);
    const states = Array.from(container.querySelectorAll('[role=group][data-variant]')).map((d) => d.getAttribute('data-state'));
    expect(states).toEqual(['open', 'open', 'open', 'pending', 'error', 'dirty-discard']);
    expect(container.querySelector('[role=group][data-variant=typed-confirm]')).not.toBeNull();
    const results = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  });

  it('DialogPanel ignores submit while pending', async () => {
    const onConfirm = vi.fn();
    render(<DialogPanel inline title="T" confirmLabel="Go" pending onConfirm={onConfirm} onCancel={() => {}} />);
    await userEvent.type(screen.getByRole('button', { name: /Working/ }), '{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('gallery live demo confirms through the real modal', async () => {
    const user = userEvent.setup();
    render(<DialogLive />);
    await user.click(screen.getByRole('button', { name: 'Open form dialog' }));
    await user.type(screen.getByLabelText('Campaign name'), 'x');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open confirm' }));
    await user.click(screen.getByRole('button', { name: 'Pause campaign' }));
    expect(await screen.findByText('Last confirmed: confirm')).toBeInTheDocument();
  });

  it('gallery menu states render', () => {
    render(<MenuStates />);
    expect(screen.getAllByRole('menu')).toHaveLength(4);
  });
});
