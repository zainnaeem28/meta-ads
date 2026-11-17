'use client';

import { useId } from 'react';
import { Icon } from '../../icons';
import { Button } from '../cmp-003/Button';
import { Input } from '../cmp-004/Input';

export interface FilterChip {
  id: string;
  label: string;
  count?: number;
}

export interface FilterBarProps {
  /** Accessible label of the search field (also its placeholder). */
  searchLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  chips: FilterChip[];
  /** Selected chip id; an empty string means none (single select). */
  status: string;
  onStatusChange: (status: string) => void;
  /** Resets the query and the chip. Shown only while a filter is active. */
  onClearAll: () => void;
  className?: string;
}

const CHIP_CLASS =
  'inline-flex items-center gap-1 rounded-full border px-3 min-h-control-sm max-md:min-h-control-touch ' +
  'text-ui font-medium transition-colors duration-(--duration-fast) ease-standard ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** CMP-017 filter bar: search field, single-select count chips (toggle buttons) and clear-all. */
export function FilterBar({
  searchLabel,
  query,
  onQueryChange,
  chips,
  status,
  onStatusChange,
  onClearAll,
  className,
}: FilterBarProps) {
  const searchId = useId();
  const active = query !== '' || status !== '';
  return (
    <div className={['flex flex-wrap items-center gap-3', className].filter(Boolean).join(' ')}>
      <div className="relative min-w-0 flex-1 basis-64">
        <label htmlFor={searchId} className="sr-only">
          {searchLabel}
        </label>
        <Icon
          name="search"
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={searchId}
          type="search"
          value={query}
          placeholder={searchLabel}
          className="pl-10"
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>
      {chips.length > 0 ? (
        <div role="group" aria-label="Filter by status" className="inline-flex flex-wrap gap-2">
          {chips.map((chip) => {
            const pressed = chip.id === status;
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={pressed}
                data-state={pressed ? 'selected' : 'default'}
                onClick={() => onStatusChange(pressed ? '' : chip.id)}
                className={`${CHIP_CLASS} ${
                  pressed
                    ? 'border-foreground bg-foreground text-card'
                    : 'border-input bg-card text-foreground hover:bg-accent'
                }`}
              >
                {chip.label}{' '}
                {chip.count !== undefined ? (
                  <span className={pressed ? 'text-caption' : 'text-caption text-muted-foreground'}>
                    {chip.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {active ? (
        <Button variant="ghost" size="sm" onClick={onClearAll}>
          Clear all
        </Button>
      ) : null}
    </div>
  );
}

export interface NoMatchesProps {
  onClearAll: () => void;
}

/** CMP-017 "no matches" state: says so plainly and offers the way back. */
export function NoMatches({ onClearAll }: NoMatchesProps) {
  return (
    <div role="status" className="flex flex-col items-start gap-3 py-6 text-ui">
      <p className="text-muted-foreground">No results match these filters.</p>
      <Button variant="outline" size="sm" onClick={onClearAll}>
        Clear all
      </Button>
    </div>
  );
}
