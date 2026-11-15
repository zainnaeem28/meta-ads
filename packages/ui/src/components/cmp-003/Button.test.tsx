import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { Button, type ButtonVariant } from './index';

const VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'destructive-outline',
  'icon-only',
];

describe('CMP-003 Button', () => {
  it.each(VARIANTS)('%s renders a native button with its variant tokens', (variant) => {
    render(
      <Button variant={variant} aria-label="Go">
        Go
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', variant);
  });

  it('uses token sizes: 40 px, small 32 px, and 44 px on a phone', () => {
    const { rerender } = render(<Button>A</Button>);
    expect(screen.getByRole('button').className).toContain('min-h-control');
    expect(screen.getByRole('button').className).toContain('max-md:min-h-control-touch');
    rerender(<Button size="sm">A</Button>);
    expect(screen.getByRole('button').className).toContain('min-h-control-sm');
    expect(screen.getByRole('button').className).toContain('max-md:min-h-control-touch');
    rerender(
      <Button variant="icon-only" aria-label="A" size="sm">
        A
      </Button>,
    );
    expect(screen.getByRole('button').className).toContain('w-control-sm');
    rerender(
      <Button variant="icon-only" aria-label="A">
        A
      </Button>,
    );
    expect(screen.getByRole('button').className).toContain('max-md:w-control-touch');
  });

  it('activates with Enter and Space, and a click', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.setup().click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toBeDisabled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('pending: aria-busy, swaps the label, ignores clicks, keeps both labels for a stable width', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button pendingLabel="Saving…" onClick={onClick}>
        Save changes
      </Button>,
    );
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('button')).toHaveTextContent('Save changesSaving…');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    rerender(
      <Button pending pendingLabel="Saving…" onClick={onClick}>
        Save changes
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveTextContent('Save changesSaving…');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('pending without a pending label keeps the label and adds the spinner', () => {
    render(<Button pending>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('renders an anchor with asChild and blocks it when disabled or pending', () => {
    const { rerender } = render(
      <Button asChild>
        <a href="#x">Top</a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'Top' })).toHaveAttribute('data-variant', 'primary');
    expect(screen.getByRole('link')).not.toHaveAttribute('aria-disabled');
    const onClick = vi.fn();
    rerender(
      <Button asChild disabled onClick={onClick}>
        <a href="#x">Top</a>
      </Button>,
    );
    expect(screen.getByRole('link')).toHaveAttribute('aria-disabled', 'true');
    expect(fireEvent.click(screen.getByRole('link'))).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('has no axe violations in any variant and state', async () => {
    const { container } = render(
      <div>
        {VARIANTS.map((v) => (
          <span key={v}>
            <Button variant={v} aria-label={`${v} a`}>
              x
            </Button>
            <Button variant={v} aria-label={`${v} b`} disabled>
              x
            </Button>
            <Button variant={v} aria-label={`${v} c`} pending pendingLabel="y">
              x
            </Button>
          </span>
        ))}
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
