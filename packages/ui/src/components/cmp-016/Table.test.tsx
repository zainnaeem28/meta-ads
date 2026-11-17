// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Table, type TableColumn } from './index';
import { TableDemo, ErrorDemo } from './gallery-demos';

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
}
const ROWS: Row[] = [
  { id: '1', name: 'Alpha' },
  { id: '2', name: 'Beta' },
];
const COLS: TableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortable: true },
];

const base = { label: 'Campaigns', columns: COLS, rows: ROWS, rowKey: (r: Row) => r.id };

describe('CMP-016 Table', () => {
  it('is a labelled focusable scroll region with th scope=col and named sort buttons', async () => {
    const onSort = vi.fn();
    const { container } = render(
      <Table {...base} sort={{ columnId: 'name', direction: 'ascending' }} onSortChange={onSort} />,
    );
    const region = screen.getByRole('region', { name: 'Campaigns' });
    expect(region).toHaveAttribute('tabindex', '0');
    const th = screen.getByRole('columnheader');
    expect(th).toHaveAttribute('scope', 'col');
    expect(th).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: 'Sort by Name' }));
    expect(onSort).toHaveBeenCalledWith('name');
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('labels each cell for the stacked layout under 768 px', () => {
    render(<Table {...base} />);
    const cell = within(screen.getAllByRole('row')[1]!).getAllByRole('cell')[0]!;
    expect(within(cell).getByText('Name').className).toContain('md:hidden');
  });

  it('marks the selected row and the row whose action is pending', async () => {
    const onAction = vi.fn();
    const { container } = render(
      <Table
        {...base}
        selectedKeys={new Set(['1'])}
        pendingKeys={new Set(['2'])}
        rowAction={{ label: 'Open', onAction }}
      />,
    );
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
    expect(within(rows[1]!).getByText('(selected)')).toBeInTheDocument();
    expect(rows[2]).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Open' }));
    expect(onAction).toHaveBeenCalledWith(ROWS[0]);
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('loading shows a busy skeleton announced as Loading', async () => {
    const { container } = render(<Table {...base} state="loading" />);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('empty and no-matches use the empty state; error is an alert with Try again', async () => {
    const onRetry = vi.fn();
    const { container, rerender } = render(
      <Table {...base} rows={[]} state="empty" emptyTitle="Nothing" />,
    );
    expect(screen.getByRole('heading', { name: 'Nothing' })).toBeInTheDocument();
    rerender(
      <Table {...base} rows={[]} state="empty" emptyVariant="no-matches" emptyTitle="None match" />,
    );
    expect(container.querySelector('[data-variant=no-matches]')).not.toBeNull();
    rerender(<Table {...base} state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe('gallery demos', () => {
  it('table demo sorts by clicking a sort button and records the row action', async () => {
    render(<TableDemo />);
    const first = () => within(screen.getAllByRole('row')[1]!).getAllByRole('cell')[0]!.textContent;
    expect(first()).toContain('Evening Calm');
    await userEvent.click(screen.getByRole('button', { name: 'Sort by Campaign' }));
    expect(first()).toContain('Morning Focus Blend');
    await userEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!);
    expect(screen.getByTestId('table-last')).toHaveTextContent('a');
  });

  it('error demo counts retries', async () => {
    render(<ErrorDemo />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('retry-count')).toHaveTextContent('retries: 1');
  });

  it('offers a visible sort group for narrow screens and explicit table roles', async () => {
    const onSort = vi.fn();
    const { container } = render(
      <Table {...base} sort={{ columnId: 'name', direction: 'ascending' }} onSortChange={onSort} />,
    );
    const group = screen.getByRole('group', { name: 'Order list' });
    expect(group.className).toContain('md:hidden');
    const btn = within(group).getByRole('button', { name: 'Order by Name, ascending' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(onSort).toHaveBeenCalledWith('name');
    expect(container.querySelector('thead')?.className).toContain('max-md:hidden');
    expect(container.querySelector('thead')?.className).not.toContain('sr-only');
    expect(container.querySelector('tbody')).toHaveAttribute('role', 'rowgroup');
    expect(container.querySelector('tbody tr')).toHaveAttribute('role', 'row');
    expect(container.querySelector('tbody td')).toHaveAttribute('role', 'cell');
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
