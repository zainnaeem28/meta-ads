import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { Input, KeyInput, Textarea } from './index';

describe('CMP-004 Input and textarea', () => {
  it('text input: native, label, invalid and describedby, disabled, read-only', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Input aria-label="Name" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.type(input, 'abc');
    expect(input).toHaveValue('abc');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input.className).toContain('min-h-control');
    expect(input.className).toContain('max-md:min-h-control-touch');
    rerender(<Input aria-label="Name" invalid aria-describedby="e" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-describedby', 'e');
    rerender(<Input aria-label="Name" disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    cleanup();
    render(<Input aria-label="Name" readOnly defaultValue="x" />);
    await user.type(screen.getByRole('textbox'), 'zz');
    expect(screen.getByRole('textbox')).toHaveValue('x');
  });

  it('masked key input: password type, autocomplete off, no reveal control', () => {
    const { container } = render(<KeyInput aria-label="Key" invalid defaultValue="secret" />);
    const input = container.querySelector('input')!;
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('textarea counter follows typing, warns near the limit, joins aria-describedby', async () => {
    const user = userEvent.setup();
    render(<Textarea id="t" aria-label="Brief" maxLength={10} aria-describedby="help" />);
    const area = screen.getByRole('textbox', { name: 'Brief' });
    expect(area).toHaveAttribute('aria-describedby', 'help t-counter');
    const counter = () => document.getElementById('t-counter')!;
    expect(counter()).toHaveTextContent('0 / 10');
    expect(counter().className).toContain('text-muted-foreground');
    await user.type(area, '123456789');
    expect(counter()).toHaveTextContent('9 / 10');
    expect(counter().className).toContain('text-warning');
    await user.type(area, '0x');
    expect(counter()).toHaveTextContent('10 / 10');
    expect(counter().className).toContain('text-destructive');
  });

  it('textarea works controlled and without a counter', () => {
    const { rerender } = render(
      <Textarea id="c" aria-label="Brief" maxLength={5} value="abc" onChange={() => {}} invalid />,
    );
    expect(document.getElementById('c-counter')).toHaveTextContent('3 / 5');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    rerender(<Textarea aria-label="Brief" />);
    expect(document.querySelector('[data-counter]')).toBeNull();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-describedby');
  });

  it('has no axe violations in any state', async () => {
    const { container } = render(
      <div>
        <label>
          Name <Input />
        </label>
        <Input aria-label="Invalid" invalid aria-describedby="e" />
        <p id="e">Error</p>
        <Input aria-label="Disabled" disabled />
        <Input aria-label="Read-only" readOnly />
        <KeyInput aria-label="Key" />
        <Textarea id="a" aria-label="Brief" maxLength={20} />
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
