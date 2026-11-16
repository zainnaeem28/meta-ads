'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Destructive row action (delete, remove). */
  destructive?: boolean;
  onSelect?: () => void;
}

export interface MenuProps {
  /** Visible text or icon of the trigger button. */
  trigger: ReactNode;
  /** Accessible name of the trigger and the menu, e.g. "Account" or "Actions for Spring launch". */
  label: string;
  items: MenuItem[];
  /** Account menu: heading block (name, email) above the items. */
  header?: ReactNode;
  /** Mount open (gallery states). */
  defaultOpen?: boolean;
  /** With `defaultOpen`: focus the first item on mount (gallery focus state). */
  initialFocus?: boolean;
  /** Which edge of the trigger the menu lines up with; `end` for triggers at the right edge (account menu). */
  align?: 'start' | 'end';
  className?: string;
}

const ITEM_CLASS =
  'flex w-full items-center px-3 min-h-control max-md:min-h-control-touch text-left text-ui ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/** CMP-020 menu button (phone: spans its nearest positioned ancestor less 12 px each side, so give that ancestor the page width): opens on click, Enter, Space or ArrowDown; arrows, Home and End move; Escape closes and returns focus. */
export function Menu({ trigger, label, items, header, defaultOpen = false, initialFocus = false, align = 'start', className }: MenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const base = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
  const pendingFocus = useRef<'first' | 'last' | null>(defaultOpen && initialFocus ? 'first' : null);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const openWith = (at: 'first' | 'last') => {
    pendingFocus.current = at;
    setOpen(true);
  };

  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    const index = pendingFocus.current === 'first' ? enabled[0] : enabled[enabled.length - 1];
    pendingFocus.current = null;
    if (index !== undefined) itemRefs.current[index]?.focus();
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openWith('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openWith('last');
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const active = itemRefs.current.findIndex((el) => el === document.activeElement);
    const at = enabled.indexOf(active);
    const go = (i: number | undefined) => {
      event.preventDefault();
      if (i !== undefined) itemRefs.current[i]?.focus();
    };
    if (event.key === 'ArrowDown') go(enabled[(at + 1) % enabled.length]);
    else if (event.key === 'ArrowUp') go(enabled[(at - 1 + enabled.length) % enabled.length]);
    else if (event.key === 'Home') go(enabled[0]);
    else if (event.key === 'End') go(enabled[enabled.length - 1]);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') close(false);
  };

  return (
    <div ref={rootRef} className={['relative inline-block max-md:static', className].filter(Boolean).join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        id={`${base}-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${base}-menu` : undefined}
        aria-label={label}
        onClick={() => (open ? close(false) : openWith('first'))}
        onKeyDown={onTriggerKeyDown}
        className="inline-flex min-h-control max-md:min-h-control-touch items-center gap-2 rounded-md border border-input bg-card px-3 text-ui hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={`${base}-menu`}
          role="menu"
          aria-labelledby={`${base}-trigger`}
          onKeyDown={onMenuKeyDown}
          className={`absolute ${align === 'end' ? 'right-0' : 'left-0'} top-full z-40 mt-1 min-w-55 overflow-hidden rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md max-md:inset-x-3 max-md:top-auto max-md:min-w-0`}
        >
          {header ? <div className="border-b border-border px-3 py-2 text-ui">{header}</div> : null}
          {items.map((item, i) => (
            <button
              key={item.id}
              ref={(node) => {
                itemRefs.current[i] = node;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabled ? true : undefined}
              data-state={item.disabled ? 'disabled' : 'default'}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect?.();
                close(true);
              }}
              className={`${ITEM_CLASS} ${
                item.disabled
                  ? 'cursor-not-allowed text-disabled-foreground'
                  : `hover:bg-accent focus-visible:bg-accent ${item.destructive ? 'text-destructive' : ''}`
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
