'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons';
import type { IconName } from '../../icons';

export const TOAST_VARIANTS = ['success', 'info', 'error'] as const;
export type ToastVariant = (typeof TOAST_VARIANTS)[number];
export type ToastState = 'appearing' | 'visible' | 'dismissed';

/** Auto-dismiss delay for success and info toasts; errors stay until closed. */
export const TOAST_DURATION_MS = 6000;

const ICON: Record<ToastVariant, IconName> = {
  success: 'circle-check',
  info: 'info',
  error: 'circle-x',
};
const ICON_TONE: Record<ToastVariant, string> = {
  success: 'text-success',
  info: 'text-info',
  error: 'text-destructive',
};
const BORDER: Record<ToastVariant, string> = {
  success: 'border-l-success',
  info: 'border-l-info',
  error: 'border-l-destructive',
};

export interface ToastProps {
  id: string;
  variant?: ToastVariant;
  message: string;
  action?: ReactNode;
  /** Gallery and tests can pin a state; the live product leaves it `visible`. */
  state?: ToastState;
  /** Critical errors never auto-dismiss, whatever the variant. */
  critical?: boolean;
  onDismiss: (id: string) => void;
}

/** CMP-012: one toast. 360 px top-right, full width less 32 px on a phone. */
export function Toast({
  id,
  variant = 'info',
  message,
  action,
  state = 'visible',
  critical = false,
  onDismiss,
}: ToastProps) {
  const sticky = critical || variant === 'error';
  // Hosts often pass a new callback each render; a ref keeps the timer from restarting.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  useEffect(() => {
    if (sticky || paused || state === 'dismissed') return undefined;
    const timer = setTimeout(() => dismissRef.current(id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [sticky, paused, state, id]);

  if (state === 'dismissed') return null;
  return (
    <div
      data-variant={variant}
      data-state={state}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      className={[
        'pointer-events-auto flex w-full items-start gap-3 rounded-md border border-border border-l-4 bg-popover p-4 text-ui text-popover-foreground shadow-md',
        BORDER[variant],
        state === 'appearing' ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
        'transition duration-200 motion-reduce:transition-none',
      ].join(' ')}
    >
      <span className={`mt-px shrink-0 ${ICON_TONE[variant]}`}>
        <Icon name={ICON[variant]} size={20} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="break-words">{message}</p>
        {action ? <div>{action}</div> : null}
      </div>
      <button
        type="button"
        aria-label="Close notification"
        onClick={() => onDismiss(id)}
        className="-m-2 inline-flex min-h-control-sm min-w-control-sm shrink-0 items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring max-md:min-h-control-touch max-md:min-w-control-touch"
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

export interface ToastRegionProps {
  toasts: readonly Omit<ToastProps, 'onDismiss'>[];
  onDismiss: (id: string) => void;
}

/**
 * Fixed region that hosts the toasts. Errors go to an assertive live region, the rest to a polite
 * one. Both regions exist from first render so the insert is announced.
 */
export function ToastRegion({ toasts, onDismiss }: ToastRegionProps) {
  const polite = toasts.filter((t) => t.variant !== 'error');
  const assertive = toasts.filter((t) => t.variant === 'error');
  const list = (items: typeof toasts) =>
    items.map((t) => <Toast key={t.id} {...t} onDismiss={onDismiss} />);
  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-50 flex flex-col gap-2 md:inset-x-auto md:right-4 md:w-90">
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        {list(polite)}
      </div>
      <div role="alert" aria-live="assertive" className="flex flex-col gap-2">
        {list(assertive)}
      </div>
    </div>
  );
}
