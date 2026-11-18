// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tabs, type TabItem } from './index';

afterEach(cleanup);

const TABS: TabItem[] = [
  { id: 'brief', label: 'Brief' },
  { id: 'clips', label: 'Clips', count: 24 },
  { id: 'final', label: 'Final', disabled: true },
  { id: 'export', label: 'Export' },
];

function Harness({
  initial = 'brief',
  onChange,
}: {
  initial?: string;
  onChange?: (id: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs
      tabs={TABS}
      label="Campaign stages"
      value={value}
      onValueChange={(id) => {
        setValue(id);
        onChange?.(id);
      }}
    >
      <p>Panel for {value}</p>
    </Tabs>
  );
}

describe('CMP-014 Tabs', () => {
  it('exposes a labelled tablist with aria-selected, count badge and a labelled panel', async () => {
    const { container } = render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Campaign stages' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Brief' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Clips 24' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Brief');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('marks the disabled tab aria-disabled and does not select it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const final = screen.getByRole('tab', { name: 'Final' });
    expect(final).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(final);
    expect(onChange).not.toHaveBeenCalled();
    expect(final).toHaveAttribute('data-state', 'disabled');
  });

  it('moves focus and selection with arrow keys, skipping the disabled tab, wrapping, Home and End', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Brief' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Clips 24' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Export' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Brief' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Export' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Brief' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel for export');
  });

  it('keeps only the selected tab in the tab order and falls back from a disabled value', () => {
    render(<Harness initial="final" />);
    expect(screen.getByRole('tab', { name: 'Brief' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Clips 24' })).toHaveAttribute('tabindex', '-1');
  });

  it('selects on click and ignores other keys', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Export' }));
    expect(screen.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('a');
    expect(screen.getByRole('tab', { name: 'Export' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders no panel without content', () => {
    render(<Tabs tabs={TABS} label="Stages" value="brief" onValueChange={() => {}} />);
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Brief' })).not.toHaveAttribute('aria-controls');
  });

  it('points aria-controls at the rendered panel', () => {
    render(<Harness />);
    const id = screen.getByRole('tab', { selected: true }).getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', id);
  });
});
