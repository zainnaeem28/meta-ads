'use client';

import { Slot } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes, MouseEvent } from 'react';
import { Icon } from '../../icons';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'destructive'
  | 'destructive-outline'
  | 'icon-only';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `icon-only` is a ghost-style square button and requires `aria-label`. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows the spinner and `pendingLabel`; the width stays that of the longer label. */
  pending?: boolean;
  pendingLabel?: string;
  /** Render the child element (e.g. an anchor) instead of a `button`. */
  asChild?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border-transparent bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
  secondary: 'bg-secondary text-secondary-foreground border-border-strong hover:bg-secondary-hover',
  outline: 'bg-card text-foreground border-input hover:bg-accent',
  ghost: 'border-transparent bg-transparent text-foreground hover:bg-accent',
  destructive:
    'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive-hover active:bg-destructive-hover',
  'destructive-outline': 'bg-card text-destructive border-destructive hover:bg-destructive-subtle',
  'icon-only': 'border-transparent bg-transparent text-foreground hover:bg-accent',
};

const DISABLED =
  'disabled:bg-disabled disabled:text-disabled-foreground disabled:border-border disabled:cursor-not-allowed ' +
  'aria-disabled:bg-disabled aria-disabled:text-disabled-foreground aria-disabled:border-border aria-disabled:cursor-not-allowed';

function sizeClass(variant: ButtonVariant, size: ButtonSize) {
  const icon = variant === 'icon-only';
  if (size === 'sm') {
    return `min-h-control-sm max-md:min-h-control-touch ${icon ? 'w-control-sm max-md:w-control-touch px-0' : 'px-3'}`;
  }
  return `min-h-control max-md:min-h-control-touch ${icon ? 'w-control max-md:w-control-touch px-0' : 'px-4'}`;
}

/** CMP-003 Button: native `button` (or the child element with `asChild`); Enter and Space activate it. */
export function Button({
  variant = 'primary',
  size = 'md',
  pending = false,
  pendingLabel,
  asChild = false,
  className,
  children,
  disabled,
  onClick,
  type,
  ...rest
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  const blocked = pending || disabled;
  const classes = [
    'inline-flex items-center justify-center gap-2 rounded-md border text-ui font-medium no-underline whitespace-nowrap',
    'transition-colors duration-(--duration-fast) ease-standard',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    VARIANTS[variant],
    sizeClass(variant, size),
    DISABLED,
    'aria-busy:cursor-progress',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  const spinner = <Icon name="loader-circle" size={16} className="animate-spin" />;
  let content = children;
  if (!asChild && pendingLabel !== undefined) {
    // Both labels share one grid cell, so the width is that of the longer one in every state.
    content = (
      <span className="inline-grid">
        <span
          className={`col-start-1 row-start-1 inline-flex items-center justify-center ${pending ? 'invisible' : ''}`}
          aria-hidden={pending ? true : undefined}
        >
          {children}
        </span>
        <span
          className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${pending ? '' : 'invisible'}`}
          aria-hidden={pending ? undefined : true}
        >
          {spinner}
          {pendingLabel}
        </span>
      </span>
    );
  } else if (!asChild && pending && variant === 'icon-only') {
    content = spinner;
  } else if (!asChild && pending) {
    content = (
      <>
        {spinner}
        {children}
      </>
    );
  }
  return (
    <Comp
      {...rest}
      {...(asChild ? {} : { type: type ?? 'button', disabled: disabled === true })}
      aria-busy={pending ? true : undefined}
      aria-disabled={pending || (asChild && disabled) ? true : undefined}
      data-variant={variant}
      data-pending={pending ? '' : undefined}
      onClick={
        blocked && asChild ? (e: MouseEvent<HTMLButtonElement>) => e.preventDefault() : handleClick
      }
      className={classes}
    >
      {content}
    </Comp>
  );
}
