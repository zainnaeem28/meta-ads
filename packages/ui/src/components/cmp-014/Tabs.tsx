'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../../icons';

export interface TabItem {
  id: string;
  label: string;
  /** Count badge, shown for stage tabs. */
  count?: number;
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
  className?: string;
}

const TAB_CLASS =
  'inline-flex items-center gap-2 whitespace-nowrap border-b-2 -mb-px px-4 min-h-control max-md:min-h-control-touch ' +
  'text-ui font-medium transition-colors duration-(--duration-fast) ease-standard ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/** CMP-014 tabs: underline tab list with roving focus; arrow keys move and select, Home and End jump. */
export function Tabs({ tabs, value, onValueChange, label, children, className }: TabsProps) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = tabs.filter((t) => !t.disabled);
  const selected = enabled.some((t) => t.id === value) ? value : enabled[0]?.id;

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
              aria-controls={isSelected ? `${base}-panel` : undefined}
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
              {tab.label} {tab.chip ?? null}
              {tab.count !== undefined ? (
                <span className="rounded-full border border-border-strong bg-muted px-2 text-caption font-semibold text-foreground">
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {children !== undefined && selected ? (
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
