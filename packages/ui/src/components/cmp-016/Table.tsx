import type { ReactNode } from 'react';
import { Button } from '../cmp-003';
import { EmptyState } from '../cmp-019';
import { Icon } from '../../icons';

export type SortDirection = 'ascending' | 'descending';

export interface TableColumn<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
}

export interface TableSort {
  columnId: string;
  direction: SortDirection;
}

export interface TableRowAction<T> {
  label: string;
  onAction: (row: T) => void;
}

export type TableState = 'content' | 'loading' | 'empty' | 'error';

export interface TableProps<T> {
  /** Accessible name of the table and of its scroll region. */
  label: string;
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  state?: TableState;
  sort?: TableSort;
  onSortChange?: (columnId: string) => void;
  selectedKeys?: ReadonlySet<string>;
  /** Rows whose action is running. */
  pendingKeys?: ReadonlySet<string>;
  rowAction?: TableRowAction<T>;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  /** `no-matches` when filters hide every row. */
  emptyVariant?: 'empty' | 'no-matches';
  emptyAction?: ReactNode;
  skeletonRows?: number;
}

const CELL = 'px-4 py-2 max-md:block max-md:px-0 max-md:py-1';

/** CMP-016: table (stacked labelled blocks under 768 px) with skeleton, empty, error, selected and row-action-pending states. */
export function Table<T>({
  label,
  columns,
  rows,
  rowKey,
  state = 'content',
  sort,
  onSortChange,
  selectedKeys,
  pendingKeys,
  rowAction,
  onRetry,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyVariant = 'empty',
  emptyAction,
  skeletonRows = 4,
}: TableProps<T>) {
  const span = columns.length + (rowAction ? 1 : 0);
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={label}
      className="w-full overflow-x-auto rounded-md border border-border bg-card text-foreground max-md:overflow-x-visible"
    >
      <table aria-label={label} aria-busy={state === 'loading' || undefined} className="w-full border-collapse text-ui max-md:block">
        <thead className="bg-muted text-left max-md:sr-only">
          <tr>
            {columns.map((c) => {
              const active = sort?.columnId === c.id ? sort.direction : undefined;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={c.sortable ? (active ?? 'none') : undefined}
                  className="px-4 py-2 font-semibold"
                >
                  {c.sortable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Sort by ${c.header}`}
                      onClick={() => onSortChange?.(c.id)}
                    >
                      {c.header}
                      <Icon
                        name={active === 'ascending' ? 'chevron-up' : active === 'descending' ? 'chevron-down' : 'arrow-up-down'}
                        size={16}
                      />
                    </Button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
            {rowAction ? (
              <th scope="col" className="px-4 py-2 font-semibold">
                Actions
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="max-md:block">
          {state === 'loading'
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={i} data-skeleton className="min-h-control-touch border-t border-border max-md:block max-md:p-4">
                  {Array.from({ length: span }, (_, j) => (
                    <td key={j} className={CELL}>
                      <span aria-hidden="true" className="block h-4 w-3/4 rounded-sm bg-muted motion-safe:animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {state === 'loading' ? (
            <tr className="sr-only">
              <td colSpan={span} role="status">
                Loading
              </td>
            </tr>
          ) : null}
          {state === 'content'
            ? rows.map((row) => {
                const key = rowKey(row);
                const selected = selectedKeys?.has(key) ?? false;
                const pending = pendingKeys?.has(key) ?? false;
                return (
                  <tr
                    key={key}
                    data-selected={selected || undefined}
                    aria-busy={pending || undefined}
                    className={`min-h-control-touch border-t border-border max-md:block max-md:p-4 ${selected ? 'bg-accent' : ''}`}
                  >
                    {columns.map((c, i) => (
                      <td key={c.id} className={CELL}>
                        <span className="text-caption text-muted-foreground md:hidden">{c.header}</span>
                        <span className="block min-w-0 break-words">
                          {c.cell(row)}
                          {i === 0 && selected ? <span className="sr-only"> (selected)</span> : null}
                        </span>
                      </td>
                    ))}
                    {rowAction ? (
                      <td className={CELL}>
                        <Button
                          variant="outline"
                          size="sm"
                          pending={pending}
                          pendingLabel="Working…"
                          onClick={() => rowAction.onAction(row)}
                        >
                          {rowAction.label}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                );
              })
            : null}
          {state === 'empty' || state === 'error' ? (
            <tr className="border-t border-border max-md:block">
              <td colSpan={span} className="max-md:block">
                {state === 'error' ? (
                  <EmptyState
                    variant="error"
                    title="Could not load this list"
                    description="Check your connection and try again."
                    onRetry={onRetry}
                  />
                ) : (
                  <EmptyState
                    variant={emptyVariant}
                    title={emptyTitle}
                    description={emptyDescription}
                    action={emptyAction}
                  />
                )}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
