// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { RowsDemo } from './gallery-demos';
import { CampaignRow, ROW_VARIANTS } from './index';

afterEach(cleanup);

function renderRow(props: Partial<React.ComponentProps<typeof CampaignRow>> = {}) {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  const utils = render(
    <ul>
      <CampaignRow
        variant="history"
        name="Summer sale"
        href="/campaigns/1"
        segments={4}
        duration="0:24"
        date="12 Nov 2026"
        status={{ label: 'Ready' }}
        actions={[
          { id: 'open', label: 'Open Summer sale', onClick: onOpen },
          { id: 'delete', label: 'Delete Summer sale', onClick: onDelete, destructive: true },
        ]}
        {...props}
      />
    </ul>,
  );
  return { ...utils, onOpen, onDelete };
}

describe('CMP-027 Campaign row', () => {
  it.each(ROW_VARIANTS)('%s variant passes axe', async (variant) => {
    const { container } = renderRow({ variant, posterSrc: variant === 'history' ? '/p.png' : undefined });
    expect(screen.getByRole('listitem')).toHaveAttribute('data-variant', variant);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('the name is the only link; actions are separate buttons', async () => {
    const user = userEvent.setup();
    const { onDelete } = renderRow();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Summer sale' })).toHaveAttribute('href', '/campaigns/1');
    await user.click(screen.getByRole('button', { name: 'Delete Summer sale' }));
    expect(onDelete).toHaveBeenCalled();
  });

  it('shows meta and a draft default badge, with a singular segment', () => {
    renderRow({ variant: 'draft', segments: 1, duration: undefined, status: { label: 'Draft' } });
    expect(screen.getByText('1 segment · 12 Nov 2026')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toHaveAttribute('data-variant', 'neutral');
  });

  it('an icon action is a ghost icon-only button named in full; a draft has no segment count', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const { container } = renderRow({
      variant: 'draft',
      segments: undefined,
      duration: undefined,
      format: 'UGC ad',
      status: { label: 'Draft' },
      actions: [{ id: 'delete', label: 'Delete draft A very long product name indeed', icon: 'trash-2', destructive: true, onClick: onDelete }],
    });
    expect(screen.getByText('UGC ad · 12 Nov 2026')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Delete draft A very long product name indeed' });
    expect(button).toHaveTextContent('');
    await user.click(button);
    expect(onDelete).toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('history defaults to the success badge', () => {
    renderRow();
    expect(screen.getByText('Ready')).toHaveAttribute('data-variant', 'success');
    expect(screen.getByText('4 segments · 0:24 · 12 Nov 2026')).toBeInTheDocument();
  });

  it('deleting hides actions and announces status', async () => {
    const { container } = renderRow({ deleting: true });
    expect(screen.getByRole('listitem')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Deleting');
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('works without actions', () => {
    renderRow({ actions: undefined });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keyboard: Tab reaches the link then each action', async () => {
    const user = userEvent.setup();
    renderRow();
    await user.tab();
    expect(screen.getByRole('link')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Open Summer sale' })).toHaveFocus();
  });
});

describe('CMP-027 gallery demo', () => {
  it('renders history, draft and deleting rows', async () => {
    const { container } = render(<RowsDemo />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(await axeViolations(container)).toEqual([]);
  });
});
