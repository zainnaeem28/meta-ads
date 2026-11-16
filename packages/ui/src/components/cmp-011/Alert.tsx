import type { HTMLAttributes, ReactNode } from 'react';
import { Icon } from '../../icons';
import type { IconName } from '../../icons';

export const ALERT_VARIANTS = ['info', 'success', 'warning', 'destructive'] as const;
export type AlertVariant = (typeof ALERT_VARIANTS)[number];

const VARIANT_CLASS: Record<AlertVariant, string> = {
  info: 'bg-info-subtle border-info-border text-foreground',
  success: 'bg-success-subtle border-success-border text-foreground',
  warning: 'bg-warning-subtle border-warning-border text-foreground',
  destructive: 'bg-destructive-subtle border-destructive-border text-foreground',
};

const ICON_TONE: Record<AlertVariant, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

const ICON: Record<AlertVariant, IconName> = {
  info: 'info',
  success: 'circle-check',
  warning: 'triangle-alert',
  destructive: 'circle-x',
};

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'role'> {
  variant?: AlertVariant;
  title?: string;
  /** Optional action (a button or link) shown under the body. */
  action?: ReactNode;
  /** Blocking errors use `alert`; everything else is polite `status`. Defaults to `alert` for destructive. */
  role?: 'status' | 'alert';
  children?: ReactNode;
}

/** CMP-011: persistent, full-width message. Announced when inserted; never auto-dismissed. */
export function Alert({
  variant = 'info',
  title,
  action,
  role,
  className,
  children,
  ...rest
}: AlertProps) {
  const classes = [
    'flex w-full items-start gap-3 rounded-md border p-4 text-ui',
    VARIANT_CLASS[variant],
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      role={role ?? (variant === 'destructive' ? 'alert' : 'status')}
      data-variant={variant}
      className={classes}
      {...rest}
    >
      <span className={`mt-px shrink-0 ${ICON_TONE[variant]}`}>
        <Icon name={ICON[variant]} size={20} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="break-words">{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
