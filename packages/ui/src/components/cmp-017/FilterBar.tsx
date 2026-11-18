'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../icons';
import { Button } from '../cmp-003/Button';
import { Input } from '../cmp-004/Input';

export interface FilterChip {
  id: string;
  label: string;
  /** `null`: not known yet (a same-size placeholder is drawn); `undefined`: this chip has no count. */
  count?: number | null;
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
  /** Digits the count slot reserves (default 3: up to 999, then `999+`). */
  reserve?: 2 | 3;
  className?: string;
}

const MAX_COUNT = 999;
const SLOT_WIDTH = {
  2: 'min-w-(--count-slot-2)',
  3: 'min-w-(--count-slot-3)',
  4: 'min-w-(--count-slot-4)',
} as const;
/** Edge fade on the side of the phone chip row that has more chips (UI-UX §5.1). */
const FADE_END = 'linear-gradient(to right, black calc(100% - var(--edge-fade)), transparent)';
const FADE_START = 'linear-gradient(to left, black calc(100% - var(--edge-fade)), transparent)';
const FADE_BOTH =
  'linear-gradient(to right, transparent, black var(--edge-fade), black calc(100% - var(--edge-fade)), transparent)';

const CHIP_CLASS =
  'inline-flex shrink-0 items-center gap-1 rounded-full border px-3 min-h-control-sm max-md:min-h-control-touch ' +
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
  reserve = 3,
  className,
}: FilterBarProps) {
  const searchId = useId();
  const active = query !== '' || status !== '';
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });

  // On a phone the chips are one scrolling row: show a fade on the side that has more chips.
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((old) => (old.start === start && old.end === end ? old : { start, end }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [chips.length]);

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = buttons[at + (event.key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  const mask =
    more.start && more.end ? FADE_BOTH : more.end ? FADE_END : more.start ? FADE_START : undefined;
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
      <div
        ref={row}
        role="group"
        aria-label="Filter by status"
        tabIndex={0}
        onKeyDown={onRowKeyDown}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="inline-flex scroll-px-4 gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:w-full max-md:flex-nowrap max-md:overflow-x-auto md:flex-wrap"
      >
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
                  ? 'border-primary bg-primary-subtle text-primary-active'
                  : 'border-input bg-card text-foreground hover:bg-accent'
              }`}
            >
              {chip.label}{' '}
              {chip.count === undefined ? null : chip.count === null ? (
                <span
                  aria-hidden="true"
                  data-count-slot="loading"
                  className={`rounded-full bg-muted text-center text-caption tabular-nums text-transparent ${SLOT_WIDTH[reserve]}`}
                >
                  {'0'.repeat(reserve)}
                </span>
              ) : (
                <span
                  data-count-slot="loaded"
                  className={`text-center text-caption tabular-nums text-muted-foreground ${SLOT_WIDTH[chip.count > MAX_COUNT ? 4 : reserve]}`}
                >
                  {chip.count > MAX_COUNT ? `${MAX_COUNT}+` : chip.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
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
