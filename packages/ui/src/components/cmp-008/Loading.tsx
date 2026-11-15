import type { HTMLAttributes, ReactNode } from 'react';

/** CMP-008: spinner. A visible text status always accompanies it; the ring itself is decorative. */
export function Spinner({
  label,
  className,
  ...rest
}: { label: string } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return (
    <span
      role="status"
      className={['inline-flex items-center gap-2 text-ui text-muted-foreground', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <span
        aria-hidden="true"
        data-spinner=""
        className="size-4 shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-primary motion-reduce:animate-none motion-reduce:border-t-border-strong motion-reduce:border-r-primary"
      />
      {label}
    </span>
  );
}

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Accessible name of the progress bar. */
  label: string;
  /** 0 to 100 for determinate; omit for indeterminate. */
  value?: number;
}

/** CMP-008: progress bar, `role="progressbar"` with its value when determinate. */
export function Progress({ label, value, className, ...rest }: ProgressProps) {
  const determinate = value !== undefined;
  const clamped = determinate ? Math.min(100, Math.max(0, value)) : undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-valuetext={determinate ? `${clamped}%` : undefined}
      data-state={determinate ? 'determinate' : 'indeterminate'}
      className={[
        'h-2 overflow-hidden rounded-full border border-border-strong bg-border',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <div
        data-progress-fill=""
        className={
          determinate
            ? 'h-full bg-primary'
            : 'h-full w-2/5 animate-pulse bg-primary motion-reduce:animate-none'
        }
        style={determinate ? { width: `${clamped}%` } : undefined}
      />
    </div>
  );
}

/** One skeleton block; decorative, so it is hidden from assistive technology. */
export function Skeleton({
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      className={[
        'block h-4 animate-pulse rounded-sm bg-border motion-reduce:animate-none',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}

export interface SkeletonRegionProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Visible text status, e.g. "Loading campaigns". */
  status: string;
  children: ReactNode;
}

/** A loading region: `aria-busy` plus a visible text status, with skeleton blocks inside. */
export function SkeletonRegion({ status, className, children, ...rest }: SkeletonRegionProps) {
  return (
    <div
      aria-busy="true"
      className={['flex flex-col gap-2', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <p role="status" className="text-ui text-muted-foreground">
        {status}
      </p>
      {children}
    </div>
  );
}
