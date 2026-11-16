'use client';

import { useState, type ReactNode } from 'react';
import { Stepper } from '@shroomap/ui/cmp-015';
import { Tabs } from '@shroomap/ui/cmp-014';
import {
  FilterBar,
  NoMatches,
  Pagination,
  buildListSearch,
  parseListState,
  withFilter,
  type ListState,
} from '@shroomap/ui/cmp-017';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-014',
  title: 'Composites: Tabs, Stepper, Filter bar and pagination (CMP-015, CMP-017)',
  order: 14,
};

function Cell({ id, label, children }: { id: string; label: string; children: ReactNode }) {
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
const STEPS = ['Account', 'Business', 'Creative', 'Review'];
const CHIPS = [
  { id: 'all', label: 'All', count: 12 },
  { id: 'failed', label: 'Failed', count: 2 },
  { id: 'ready', label: 'Ready', count: 10 },
];

function TabsDemo({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs tabs={TABS} value={value} onValueChange={setValue} label="Campaign stages">
      <p className="text-ui">Showing {value}</p>
    </Tabs>
  );
}

function FilterDemo({ initial, rows }: { initial: ListState; rows: number }) {
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

export default function FeCompNavSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="comp-nav">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Cell id="tabs-selected" label="CMP-014 selected, default, disabled, count badges">
          <TabsDemo initial="review" />
        </Cell>
        <Cell id="tabs-first" label="CMP-014 first tab selected (hover and focus via the pointer and Tab)">
          <TabsDemo initial="all" />
        </Cell>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[0, 1, 3].map((current) => (
          <Cell key={current} id={`stepper-${current}`} label={`CMP-015 current step ${current + 1} of 4`}>
            <Stepper steps={STEPS} current={current} />
          </Cell>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Cell id="filter-default" label="CMP-017 default, with pagination">
          <FilterDemo initial={parseListState('')} rows={24} />
        </Cell>
        <Cell id="filter-selected" label="CMP-017 chip selected, page 2 (?status&page)">
          <FilterDemo initial={parseListState('?status=failed&page=2')} rows={24} />
        </Cell>
        <Cell id="filter-nomatches" label="CMP-017 no matches (?q=zzz)">
          <FilterDemo initial={parseListState('?q=zzz')} rows={0} />
        </Cell>
      </div>
    </div>
  );
}
