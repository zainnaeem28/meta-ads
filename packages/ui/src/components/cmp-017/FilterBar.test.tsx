// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FilterBar,
  NoMatches,
  Pagination,
  buildListSearch,
  parseListState,
  withFilter,
} from './index';

afterEach(cleanup);

const CHIPS = [
  { id: 'all', label: 'All', count: 12 },
  { id: 'failed', label: 'Failed', count: 2 },
  { id: 'ready', label: 'Ready' },
];

function Bar() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  return (
    <FilterBar
      searchLabel="Search campaigns"
      query={query}
      onQueryChange={setQuery}
      chips={CHIPS}
      status={status}
      onStatusChange={setStatus}
      onClearAll={() => {
        setQuery('');
        setStatus('');
      }}
    />
  );
}

describe('CMP-017 FilterBar', () => {
  it('has a labelled search, toggle-button chips with counts and no axe violations', async () => {
    const { container } = render(<Bar />);
    expect(screen.getByRole('searchbox', { name: 'Search campaigns' })).toBeInTheDocument();
    const failed = screen.getByRole('button', { name: 'Failed 2' });
    expect(failed).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Ready' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('is single select: choosing a chip unpresses the other and a second press clears it', async () => {
    render(<Bar />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Failed 2' }));
    expect(screen.getByRole('button', { name: 'Failed 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Ready' }));
    expect(screen.getByRole('button', { name: 'Failed 2' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Ready' })).toHaveAttribute('data-state', 'selected');
    await user.click(screen.getByRole('button', { name: 'Ready' }));
    expect(screen.getByRole('button', { name: 'Ready' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows Clear all while a filter is active and resets both', async () => {
    render(<Bar />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox'), 'zeta');
    await user.click(screen.getByRole('button', { name: 'All 12' }));
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'All 12' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  it('NoMatches announces itself and offers clear-all', async () => {
    const onClearAll = vi.fn();
    const { container } = render(<NoMatches onClearAll={onClearAll} />);
    expect(screen.getByRole('status')).toHaveTextContent('No results match these filters.');
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledOnce();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe('CMP-017 Pagination', () => {
  it('names the buttons, reports rows and disables Previous on the first page', async () => {
    const onPageChange = vi.fn();
    const { container } = render(
      <Pagination page={1} pageSize={10} total={25} onPageChange={onPageChange} />,
    );
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    expect(screen.getByText('25 rows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('disables Next on the last page, steps back and handles one or no rows', async () => {
    const onPageChange = vi.fn();
    const { rerender } = render(
      <Pagination page={3} pageSize={10} total={25} onPageChange={onPageChange} />,
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    rerender(<Pagination page={1} pageSize={10} total={1} onPageChange={onPageChange} />);
    expect(screen.getByText('1 row')).toBeInTheDocument();
    rerender(<Pagination page={1} pageSize={10} total={0} onPageChange={onPageChange} />);
    expect(screen.getByText('0 rows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('CMP-017 URL state', () => {
  it('round-trips ?q&status&page and omits defaults', () => {
    const state = parseListState('?q=moss&status=failed&page=3');
    expect(state).toEqual({ q: 'moss', status: 'failed', page: 3 });
    expect(buildListSearch(state)).toBe('?q=moss&status=failed&page=3');
    expect(buildListSearch({ q: '', status: '', page: 1 })).toBe('');
  });

  it('falls back to page 1 for bad pages and accepts URLSearchParams', () => {
    expect(parseListState('?page=0').page).toBe(1);
    expect(parseListState('?page=abc').page).toBe(1);
    expect(parseListState(new URLSearchParams('q=a')).q).toBe('a');
  });

  it('a new filter returns to page 1', () => {
    expect(withFilter({ q: '', status: '', page: 4 }, { status: 'ready' })).toEqual({
      q: '',
      status: 'ready',
      page: 1,
    });
  });
});
