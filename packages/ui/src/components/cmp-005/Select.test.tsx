import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { Select } from './index';

const options = (
  <>
    <option value="">Choose</option>
    <option value="a">A</option>
    <option value="b">B</option>
  </>
);

describe('CMP-005 Select', () => {
  it('is a native select that changes with the keyboard and carries aria state', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Select aria-label="Market">{options}</Select>);
    const select = screen.getByRole('combobox', { name: 'Market' });
    expect(select.tagName).toBe('SELECT');
    expect(select.className).toContain('min-h-control');
    expect(select.className).toContain('max-md:min-h-control-touch');
    await user.selectOptions(select, 'b');
    expect(select).toHaveValue('b');
    rerender(
      <Select aria-label="Market" invalid aria-describedby="e">
        {options}
      </Select>,
    );
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-describedby', 'e');
    rerender(
      <Select aria-label="Market" disabled>
        {options}
      </Select>,
    );
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('has no axe violations in any state', async () => {
    const { container } = render(
      <div>
        <Select aria-label="One">{options}</Select>
        <Select aria-label="Two" invalid aria-describedby="e">
          {options}
        </Select>
        <p id="e">Error</p>
        <Select aria-label="Three" disabled>
          {options}
        </Select>
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
