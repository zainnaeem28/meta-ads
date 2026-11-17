import type { ReactNode } from 'react';
import { Button } from '../cmp-003';
import { Icon } from '../../icons';
import type { IconName } from '../../icons';

export const EMPTY_STATE_VARIANTS = ['empty', 'no-matches', 'error'] as const;
export type EmptyStateVariant = (typeof EMPTY_STATE_VARIANTS)[number];

const ICON: Record<EmptyStateVariant, IconName> = {
  empty: 'layout-list',
  'no-matches': 'search',
  error: 'circle-alert',
};

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  title: string;
  /** One sentence. */
  description?: string;
  /** First useful action (a button or link); for `error` the Try again button is used when `onRetry` is set. */
  action?: ReactNode;
  onRetry?: () => void;
  /** Heading level of the title, so it nests correctly in the page outline. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

/** CMP-019: icon, heading, one sentence and the first useful action. A load error is announced with `role="alert"`. */
export function EmptyState({
  variant = 'empty',
  title,
  description,
  action,
  onRetry,
  headingLevel = 3,
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  const classes = ['flex flex-col items-center gap-3 px-4 py-8 text-center', className]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      role={variant === 'error' ? 'alert' : undefined}
      data-variant={variant}
      className={classes}
    >
      <span aria-hidden="true" className="text-muted-foreground">
        <Icon name={ICON[variant]} size={24} />
      </span>
      <Heading className="text-body font-semibold text-foreground">{title}</Heading>
      {description ? (
        <p className="max-w-prose text-ui text-muted-foreground">{description}</p>
      ) : null}
      {variant === 'error' && onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : (
        action
      )}
    </div>
  );
}
