// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { parseListState } from '../cmp-017';
import { Cell, FilterDemo, TabsDemo } from './gallery-demos';

afterEach(cleanup);

describe('gallery demos', () => {
  it('TabsDemo selects with the keyboard inside a labelled cell', async () => {
    render(
      <Cell id="t" label="Tabs">
        <TabsDemo initial="all" />
      </Cell>,
    );
    await userEvent.setup().click(screen.getByRole('tab', { name: 'In review 3' }));
    expect(screen.getByText('Showing review')).toBeTruthy();
  });

  it('FilterDemo mirrors state into the query string, pages, clears and shows no matches', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FilterDemo initial={parseListState('')} rows={24} />);
    await user.click(screen.getByRole('button', { name: 'Failed 2' }));
    expect(screen.getByTestId('list-search').textContent).toBe('?status=failed');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('list-search').textContent).toBe('?status=failed&page=2');
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByTestId('list-search').textContent).toBe('(none)');
    unmount();
    render(<FilterDemo initial={parseListState('?q=zzz')} rows={0} />);
    expect(screen.getByText('No results match these filters.')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Clear all' })[1]!);
    expect(screen.queryByText('No results match these filters.')).toBeNull();
  });
});
