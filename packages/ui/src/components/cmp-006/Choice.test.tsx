import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { Checkbox, NOT_IN_RELEASE, RadioCard, SegmentedControl, Switch } from './index';
import { useControllable } from './useControllable';
import { renderHook, act } from '@testing-library/react';

describe('CMP-006 Choice controls', () => {
  it('checkbox: native, toggles with Space, disabled and unavailable say why', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Checkbox label="Captions" description="Burned in" />);
    const box = screen.getByRole('checkbox', { name: /Captions/ });
    await user.tab();
    expect(box).toHaveFocus();
    await user.keyboard(' ');
    expect(box).toBeChecked();
    expect(screen.getByText('Burned in')).toBeInTheDocument();
    rerender(<Checkbox label="Captions" disabled />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByText(NOT_IN_RELEASE)).toBeNull();
    rerender(<Checkbox label="Captions" unavailable />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByText('Not in this release')).toBeInTheDocument();
  });

  it('radio cards form a native group: arrows move, disabled cards are skipped', async () => {
    const user = userEvent.setup();
    render(
      <div role="radiogroup" aria-label="Mode">
        <RadioCard name="m" value="a" label="A" description="first" defaultChecked />
        <RadioCard name="m" value="b" label="B" />
        <RadioCard name="m" value="c" label="C" unavailable />
        <RadioCard name="m" value="d" label="D" disabled />
      </div>,
    );
    const [a, b, c] = screen.getAllByRole('radio');
    expect(a).toBeChecked();
    a!.focus();
    await user.keyboard('{ArrowDown}');
    expect(b).toBeChecked();
    expect(c).toBeDisabled();
    expect(screen.getAllByText(NOT_IN_RELEASE)).toHaveLength(1);
    await user.keyboard('{ArrowDown}');
    expect(a).toBeChecked();
  });

  it('segmented control is a radio group; works uncontrolled and controlled', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const options = [
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y' },
      { value: 'z', label: 'Z', disabled: true },
    ];
    const { rerender } = render(
      <SegmentedControl aria-label="Ratio" options={options} onValueChange={onValueChange} />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Ratio' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'X' })).toBeChecked();
    screen.getByRole('radio', { name: 'X' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Y' })).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith('y');
    expect(screen.getByRole('radio', { name: 'Z' })).toBeDisabled();
    rerender(
      <SegmentedControl
        aria-label="Ratio"
        name="r"
        options={options}
        value="x"
        onValueChange={onValueChange}
      />,
    );
    expect(screen.getByRole('radio', { name: 'X' })).toBeChecked();
    await user.click(screen.getByText('Y'));
    expect(screen.getByRole('radio', { name: 'X' })).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith('y');
  });

  it('segmented control with no options renders an empty group', () => {
    render(<SegmentedControl aria-label="Empty" options={[]} />);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('switch: role=switch, Space and Enter toggle, controlled and disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const { rerender } = render(<Switch label="Notify" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole('switch', { name: 'Notify' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.tab();
    await user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Enter}');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(onCheckedChange).toHaveBeenCalledTimes(2);
    rerender(
      <Switch
        label="Notify"
        checked
        onCheckedChange={onCheckedChange}
        onClick={(e) => e.preventDefault()}
      />,
    );
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    rerender(<Switch label="Notify" checked onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    rerender(<Switch label="Notify" unavailable />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText(NOT_IN_RELEASE)).toBeInTheDocument();
    rerender(<Switch label="Notify" disabled defaultChecked />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('44 px hit region on every control', () => {
    render(
      <div>
        <Checkbox label="c" />
        <RadioCard name="r" value="1" label="r" />
        <SegmentedControl aria-label="s" options={[{ value: 'a', label: 'A' }]} />
        <Switch label="w" />
      </div>,
    );
    expect(
      document.querySelectorAll('[class*="min-h-control-touch"]').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('useControllable: uncontrolled keeps state, controlled does not', () => {
    const onChange = vi.fn();
    const un = renderHook(() => useControllable<string>(undefined, 'a', onChange));
    act(() => un.result.current[1]('b'));
    expect(un.result.current[0]).toBe('b');
    const co = renderHook(() => useControllable<string>('a', 'z', onChange));
    act(() => co.result.current[1]('b'));
    expect(co.result.current[0]).toBe('a');
    expect(onChange).toHaveBeenCalledTimes(2);
    const quiet = renderHook(() => useControllable<number>(undefined, 1));
    act(() => quiet.result.current[1](2));
    expect(quiet.result.current[0]).toBe(2);
  });

  it('has no axe violations in any state', async () => {
    const { container } = render(
      <div>
        <Checkbox label="One" />
        <Checkbox label="Two" defaultChecked />
        <Checkbox label="Three" disabled />
        <Checkbox label="Four" unavailable />
        <div role="radiogroup" aria-label="Mode">
          <RadioCard name="m" value="a" label="A" defaultChecked />
          <RadioCard name="m" value="b" label="B" unavailable />
        </div>
        <SegmentedControl
          aria-label="Ratio"
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ]}
        />
        <Switch label="On" defaultChecked />
        <Switch label="Off" />
        <Switch label="Locked" unavailable />
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
