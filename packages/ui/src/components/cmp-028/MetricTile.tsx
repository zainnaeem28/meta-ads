import { useId } from 'react';
import type { HTMLAttributes } from 'react';
import { Skeleton } from '../cmp-008';

export const TILE_VARIANTS = ['counts', 'cost'] as const;
export type TileVariant = (typeof TILE_VARIANTS)[number];

const BAR_TONE = {
  1: 'bg-chart-1',
  2: 'bg-chart-2',
  3: 'bg-chart-3',
  4: 'bg-chart-4',
  5: 'bg-chart-5',
} as const;
export type ChartTone = keyof typeof BAR_TONE;

export interface InlineBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Accessible name, e.g. "Videos finished". */
  label: string;
  value: number;
  max: number;
  tone?: ChartTone;
}

/** CMP-028: inline bar. The numeric label is always visible, so colour is never the only cue. */
export function InlineBar({ label, value, max, tone = 1, className, ...rest }: InlineBarProps) {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(safeMax, Math.max(0, value));
  const percent = Math.round((clamped / safeMax) * 100);
  const text = `${value} of ${max}`;
  return (
    <div className={['flex flex-col gap-1', className].filter(Boolean).join(' ')} {...rest}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={text}
        className="h-2 overflow-hidden rounded-full border border-border-strong bg-muted"
      >
        <div
          data-bar-fill=""
          className={`h-full ${BAR_TONE[tone]}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-caption text-muted-foreground tabular-nums" data-testid="bar-label">
        {text}
      </span>
    </div>
  );
}

export interface MetricTileProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  variant?: TileVariant;
  label: string;
  /** Formatted value. `null` means there is no data yet. */
  value?: string | null;
  unit?: string;
  /** Change text, e.g. "up 3 since last week". */
  delta?: string;
  loading?: boolean;
  bar?: Omit<InlineBarProps, 'label'> & { label?: string };
}

/** CMP-028: one figure with its label. Cost tiles are always labelled "estimated". */
export function MetricTile({
  variant = 'counts',
  label,
  value,
  unit,
  delta,
  loading = false,
  bar,
  className,
  ...rest
}: MetricTileProps) {
  const state = loading ? 'loading' : value == null ? 'no-data' : 'value';
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-busy={loading ? true : undefined}
      data-variant={variant}
      data-state={state}
      className={[
        'flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <p id={labelId} className="text-ui text-muted-foreground">
        {variant === 'cost' ? `${label} (estimated)` : label}
      </p>
      {state === 'loading' ? (
        <>
          <Skeleton className="h-8 w-24" />
          <span className="sr-only" role="status">
            Loading {label}
          </span>
        </>
      ) : state === 'no-data' ? (
        <p className="text-ui text-muted-foreground">No data yet</p>
      ) : (
        <p className="flex items-baseline gap-1">
          <span className="text-page font-semibold tabular-nums">{value}</span>
          {unit ? <span className="text-ui text-muted-foreground">{unit}</span> : null}
        </p>
      )}
      {state === 'value' && delta ? (
        <p className="text-caption text-muted-foreground">{delta}</p>
      ) : null}
      {state === 'value' && bar ? <InlineBar {...bar} label={bar.label ?? label} /> : null}
    </div>
  );
}

/** 1 up on phone, 2 up on tablet, 4 up on desktop. */
export function MetricGrid({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={['grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
