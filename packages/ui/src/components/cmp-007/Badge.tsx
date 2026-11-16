import type { HTMLAttributes, ReactNode } from 'react';
import { Icon } from '../../icons';
import type { IconName } from '../../icons';

export const BADGE_VARIANTS = [
  'neutral',
  'primary',
  'success',
  'info',
  'warning',
  'destructive',
] as const;
export type BadgeVariant = (typeof BADGE_VARIANTS)[number];

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  neutral: 'bg-muted text-foreground border-border-strong',
  primary: 'bg-primary-subtle text-primary-active border-border-strong',
  success: 'bg-success-subtle text-success border-success-border',
  info: 'bg-info-subtle text-info border-info-border',
  warning: 'bg-warning-subtle text-warning border-warning-border',
  destructive: 'bg-destructive-subtle text-destructive border-destructive-border',
};

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  variant?: BadgeVariant;
  /** Optional leading icon; decorative, the text is always the label. */
  icon?: IconName;
  children: ReactNode;
}

/** CMP-007: status badge. The text carries the meaning; colour and icon only reinforce it. */
export function Badge({ variant = 'neutral', icon, className, children, ...rest }: BadgeProps) {
  const classes = [
    'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5',
    'text-caption font-semibold',
    VARIANT_CLASS[variant],
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span data-variant={variant} className={classes} {...rest}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </span>
  );
}
