'use client';

import { useState, type ReactNode } from 'react';
import { Tabs } from './Tabs';
import {
  FilterBar,
  NoMatches,
  Pagination,
  buildListSearch,
  withFilter,
  type ListState,
} from '../cmp-017';

/** Gallery-only interactive demos (client side); the gallery section imports them through `@shroomap/ui/cmp-014/gallery-demos`. */
export function Cell({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div
      data-cell={id}
      className="flex flex-col items-stretch gap-2 rounded-md border border-border bg-card p-4 text-foreground"
    >
      <span className="text-caption text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const TABS = [
  { id: 'all', label: 'All', count: 12 },
  { id: 'review', label: 'In review', count: 3 },
  { id: 'locked', label: 'Locked', disabled: true },
  { id: 'done', label: 'Done', count: 9 },
];
const CHIPS = [
  { id: 'all', label: 'All', count: 12 },
  { id: 'failed', label: 'Failed', count: 2 },
  { id: 'ready', label: 'Ready', count: 10 },
];

export function TabsDemo({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs tabs={TABS} value={value} onValueChange={setValue} label="Campaign stages">
      <p className="text-ui">Showing {value}</p>
    </Tabs>
  );
}

export function FilterDemo({ initial, rows }: { initial: ListState; rows: number }) {
  const [state, setState] = useState(initial);
  const none = state.q === 'zzz';
  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        searchLabel="Search campaigns"
        query={state.q}
        onQueryChange={(q) => setState((s) => withFilter(s, { q }))}
        chips={CHIPS}
        status={state.status}
        onStatusChange={(status) => setState((s) => withFilter(s, { status }))}
        onClearAll={() => setState({ q: '', status: '', page: 1 })}
      />
      <code data-testid="list-search" className="text-caption">
        {buildListSearch(state) || '(none)'}
      </code>
      {none ? (
        <NoMatches onClearAll={() => setState({ q: '', status: '', page: 1 })} />
      ) : (
        <Pagination
          page={state.page}
          pageSize={10}
          total={rows}
          onPageChange={(page) => setState((s) => ({ ...s, page }))}
        />
      )}
    </div>
  );
}

