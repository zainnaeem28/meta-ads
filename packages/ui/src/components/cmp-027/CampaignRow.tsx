'use client';

import type { HTMLAttributes } from 'react';
import { Badge } from '../cmp-007';
import type { BadgeVariant } from '../cmp-007';
import { Button } from '../cmp-003';
import { Icon } from '../../icons';
import type { IconName } from '../../icons';

export const ROW_VARIANTS = ['history', 'draft'] as const;
export type RowVariant = (typeof ROW_VARIANTS)[number];

export interface RowAction {
  id: string;
  /** Full accessible name, e.g. "Delete Summer sale". */
  label: string;
  onClick: () => void;
  destructive?: boolean;
  /** Shows a ghost icon-only button; `label` stays its accessible name and tooltip. */
  icon?: IconName;
}

export interface CampaignRowProps extends Omit<HTMLAttributes<HTMLLIElement>, 'children'> {
  variant: RowVariant;
  name: string;
  href: string;
  posterSrc?: string;
  /** Omitted for a draft, which has no length yet. */
  segments?: number;
  /** Leading meta item, e.g. "UGC ad". */
  format?: string;
  /** Already formatted, e.g. "0:24". */
  duration?: string;
  /** Already formatted, e.g. "12 Nov 2026". */
  date: string;
  status: { label: string; variant?: BadgeVariant; icon?: IconName };
  actions?: RowAction[];
  /** Delete in progress: actions are off and a status is shown. */
  deleting?: boolean;
}

/** CMP-027: one campaign in a list. Render inside a `ul`. The name is the only link; actions are buttons. */
export function CampaignRow({
  variant,
  name,
  href,
  posterSrc,
  segments,
  format,
  duration,
  date,
  status,
  actions = [],
  deleting = false,
  className,
  ...rest
}: CampaignRowProps) {
  const meta = [
    format,
    segments === undefined ? undefined : `${segments} ${segments === 1 ? 'segment' : 'segments'}`,
    duration,
    date,
  ].filter(Boolean);
  return (
    <li
      data-variant={variant}
      data-state={deleting ? 'deleting' : 'default'}
      aria-busy={deleting ? true : undefined}
      className={[
        'relative flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card p-3',
        'transition-colors duration-(--duration-fast) ease-standard hover:bg-accent focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
        deleting ? 'bg-muted' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <div
        aria-hidden="true"
        className="flex aspect-9/16 w-11 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-media-placeholder text-foreground md:w-14"
      >
        {posterSrc ? (
          <img src={posterSrc} alt="" className="size-full object-cover" />
        ) : (
          <Icon name={variant === 'draft' ? 'file-text' : 'film'} size={20} />
        )}
      </div>
      <div className="flex min-w-0 basis-[calc(100%-4rem)] flex-col gap-1 md:flex-1 md:basis-0">
        <a
          href={href}
          className="truncate text-body font-semibold text-foreground no-underline after:absolute after:inset-0 hover:underline focus-visible:outline-none"
        >
          {name}
        </a>
        <p className="text-ui text-muted-foreground">{meta.join(' · ')}</p>
      </div>
      <Badge
        variant={status.variant ?? (variant === 'draft' ? 'neutral' : 'success')}
        icon={status.icon}
      >
        {status.label}
      </Badge>
      {deleting ? (
        <p role="status" className="relative z-10 flex w-full items-center gap-2 text-ui md:w-auto">
          <Icon
            name="loader-circle"
            size={16}
            className="animate-spin motion-reduce:animate-none"
          />
          Deleting
        </p>
      ) : actions.length > 0 ? (
        <div className="relative z-10 flex flex-wrap gap-2">
          {actions.map((a) =>
            a.icon ? (
              <Button
                key={a.id}
                size="sm"
                variant="icon-only"
                aria-label={a.label}
                title={a.label}
                onClick={a.onClick}
                className={
                  a.destructive
                    ? 'hover:bg-destructive-subtle hover:text-destructive focus-visible:outline-destructive'
                    : undefined
                }
              >
                <Icon name={a.icon} size={16} />
              </Button>
            ) : (
              <Button
                key={a.id}
                size="sm"
                variant={a.destructive ? 'destructive-outline' : 'outline'}
                onClick={a.onClick}
              >
                {a.label}
              </Button>
            ),
          )}
        </div>
      ) : null}
    </li>
  );
}
