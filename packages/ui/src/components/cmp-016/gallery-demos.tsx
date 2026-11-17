'use client';

import { useState } from 'react';
import { EmptyState } from '../cmp-019';
import { Table, type TableColumn, type TableSort, type TableState } from './index';

interface Row {
  id: string;
  name: string;
  status: string;
  updated: string;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Morning Focus Blend', status: 'Ready', updated: '2 Nov' },
  { id: 'b', name: 'Evening Calm', status: 'Failed', updated: '1 Nov' },
  { id: 'c', name: 'Lion’s Mane Gummies', status: 'In review', updated: '30 Oct' },
];

const COLUMNS: TableColumn<Row>[] = [
  { id: 'name', header: 'Campaign', cell: (r) => r.name, sortable: true },
  { id: 'status', header: 'Status', cell: (r) => r.status },
  { id: 'updated', header: 'Updated', cell: (r) => r.updated, sortable: true },
];

/** Gallery-only interactive table: sorting, selection and a row action that stays pending for a moment. */
export function TableDemo({
  state = 'content',
  selected,
  pending,
  emptyVariant,
}: {
  state?: TableState;
  selected?: string;
  pending?: string;
  emptyVariant?: 'empty' | 'no-matches';
}) {
  const [sort, setSort] = useState<TableSort>({ columnId: 'name', direction: 'ascending' });
  const [last, setLast] = useState('none');
  const rows = [...ROWS].sort((a, b) => {
    const key = sort.columnId === 'updated' ? 'updated' : 'name';
    const d = a[key].localeCompare(b[key]);
    return sort.direction === 'ascending' ? d : -d;
  });
  return (
    <div className="flex flex-col gap-2">
      <Table
        label="Campaigns"
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.id}
        state={state}
        sort={sort}
        onSortChange={(columnId) =>
          setSort((s) => ({
            columnId,
            direction:
              s.columnId === columnId && s.direction === 'ascending' ? 'descending' : 'ascending',
          }))
        }
        selectedKeys={new Set(selected ? [selected] : [])}
        pendingKeys={new Set(pending ? [pending] : [])}
        rowAction={{ label: 'Open', onAction: (r) => setLast(r.id) }}
        onRetry={() => setLast('retry')}
        emptyTitle={emptyVariant === 'no-matches' ? 'No campaigns match' : 'No campaigns yet'}
        emptyDescription={
          emptyVariant === 'no-matches'
            ? 'Try a different filter.'
            : 'Create your first campaign to see it here.'
        }
        emptyVariant={emptyVariant}
      />
      <code className="text-caption text-muted-foreground" data-testid="table-last">
        {last}
      </code>
    </div>
  );
}

export function ErrorDemo() {
  const [tries, setTries] = useState(0);
  return (
    <div className="flex flex-col gap-2">
      <EmptyState
        variant="error"
        title="Could not load campaigns"
        description="Check your connection and try again."
        onRetry={() => setTries((n) => n + 1)}
      />
      <code className="text-caption text-muted-foreground" data-testid="retry-count">
        retries: {tries}
      </code>
    </div>
  );
}
