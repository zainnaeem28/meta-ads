'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../../icons';

export interface TabItem {
  id: string;
  label: string;
  /**
   * Count badge, shown for stage tabs. `null` means "not known yet": a muted placeholder of the same size is drawn, so the
   * number arriving moves nothing. `undefined` means this tab has no count.
   */
  count?: number | null;
  /** Leading icon. */
  icon?: IconName;
  /** Status chip after the label, e.g. "Needs review". */
  chip?: ReactNode;
  /** Not reachable yet: stays in the list, is skipped by arrow keys and cannot be selected. */
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Content of the selected tab; rendered in a `tabpanel` labelled by its tab. */
  children?: ReactNode;
  /** Digits the count slot reserves (default 3: up to 999, then `999+`). A list that cannot pass 99 may reserve 2. */
  reserve?: 2 | 3;
  className?: string;
}

const MAX_COUNT = 999;
const SLOT_WIDTH = {
  2: 'min-w-(--count-slot-2)',
  3: 'min-w-(--count-slot-3)',
  4: 'min-w-(--count-slot-4)',
} as const;

const TAB_CLASS =
  'inline-flex items-center gap-2 whitespace-nowrap border-b-2 -mb-px px-4 min-h-control max-md:min-h-control-touch ' +
  'text-ui font-medium transition-colors duration-(--duration-fast) ease-standard ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/** CMP-014 tabs: underline tab list with roving focus; arrow keys move and select, Home and End jump. */
export function Tabs({
  tabs,
  value,
  onValueChange,
  label,
  children,
  reserve = 3,
  className,
}: TabsProps) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = tabs.filter((t) => !t.disabled);
  const selected = enabled.some((t) => t.id === value) ? value : enabled[0]?.id;

  const hasPanel = children !== undefined && selected !== undefined;

  const move = (to: TabItem | undefined) => {
    if (!to) return;
    refs.current.get(to.id)?.focus();
    onValueChange(to.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const at = enabled.findIndex((t) => t.id === id);
    const keys: Record<string, TabItem | undefined> = {
      ArrowRight: enabled[(at + 1) % enabled.length],
      ArrowLeft: enabled[(at - 1 + enabled.length) % enabled.length],
      Home: enabled[0],
      End: enabled[enabled.length - 1],
    };
    if (event.key in keys) {
      event.preventDefault();
      move(keys[event.key]);
    }
  };

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((tab) => {
          const isSelected = tab.id === selected;
          const state = tab.disabled
            ? 'cursor-not-allowed border-transparent text-disabled-foreground'
            : isSelected
              ? 'border-primary font-semibold text-foreground'
              : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground';
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) refs.current.set(tab.id, node);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={isSelected && hasPanel ? `${base}-panel` : undefined}
              aria-disabled={tab.disabled ? true : undefined}
              tabIndex={isSelected ? 0 : -1}
              data-state={tab.disabled ? 'disabled' : isSelected ? 'selected' : 'default'}
              onClick={() => {
                if (!tab.disabled) onValueChange(tab.id);
              }}
              onKeyDown={(e) => onKeyDown(e, tab.id)}
              className={`${TAB_CLASS} ${state}`}
            >
              {tab.icon ? <Icon name={tab.icon} size={16} /> : null}
              {tab.label} {tab.chip ?? null}{' '}
              {tab.count === undefined ? null : tab.count === null ? (
                <span
                  aria-hidden="true"
                  data-count-slot="loading"
                  className={`box-content rounded-full border border-border-strong bg-muted px-2 text-center text-caption font-semibold tabular-nums text-transparent ${SLOT_WIDTH[reserve]}`}
                >
                  {'0'.repeat(reserve)}
                </span>
              ) : (
                <span
                  data-count-slot="loaded"
                  className={`box-content rounded-full border border-border-strong bg-muted px-2 text-center text-caption font-semibold tabular-nums text-foreground ${SLOT_WIDTH[tab.count > MAX_COUNT ? 4 : reserve]}`}
                >
                  {tab.count > MAX_COUNT ? `${MAX_COUNT}+` : tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {hasPanel ? (
        <div
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-tab-${selected}`}
          tabIndex={0}
          className="pt-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
