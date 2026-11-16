import type { ReactNode } from 'react';
import { EmptyState } from '../cmp-019';
import { Icon } from '../../icons';

export const CARD_VARIANTS = ['plain', 'section'] as const;
export type CardVariant = (typeof CARD_VARIANTS)[number];
export type CardState = 'loading' | 'content' | 'empty' | 'unavailable';

export interface CardProps {
  variant?: CardVariant;
  state?: CardState;
  title?: string;
  /** Heading level inside the card; the heading is omitted when there is no title. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Makes the whole card one link (stretched on the title); the body and footer must then hold nothing interactive. */
  href?: string;
  footer?: ReactNode;
  /** Shown for `state="empty"`. */
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<CardVariant, string> = {
  plain: 'p-4',
  section: 'p-6 max-md:p-4',
};

/** CMP-018: header, body and footer on `--card` with a `--border`; fluid width. */
export function Card({
  variant = 'plain',
  state = 'content',
  title,
  headingLevel = 3,
  href,
  footer,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  className,
  children,
}: CardProps) {
  const Heading = `h${headingLevel}` as const;
  const classes = [
    'relative flex w-full min-w-0 flex-col gap-3 rounded-md border border-border bg-card text-foreground',
    VARIANT_CLASS[variant],
    href ? 'hover:bg-accent focus-within:outline focus-within:outline-2 focus-within:outline-ring' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <section data-variant={variant} data-state={state} aria-busy={state === 'loading' || undefined} className={classes}>
      {title ? (
        <Heading className="text-body font-semibold">
          {href ? (
            <a href={href} className="outline-none after:absolute after:inset-0">
              {title}
            </a>
          ) : (
            title
          )}
        </Heading>
      ) : null}
      {state === 'loading' ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">Loading</span>
          <span aria-hidden="true" className="h-4 w-3/4 rounded-sm bg-muted motion-safe:animate-pulse" />
          <span aria-hidden="true" className="h-4 w-full rounded-sm bg-muted motion-safe:animate-pulse" />
          <span aria-hidden="true" className="h-4 w-1/2 rounded-sm bg-muted motion-safe:animate-pulse" />
        </div>
      ) : null}
      {state === 'content' ? <div className="min-w-0 break-words text-ui">{children}</div> : null}
      {state === 'empty' ? (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          headingLevel={Math.min(headingLevel + 1, 6) as 3 | 4 | 5 | 6}
          className="py-4"
        />
      ) : null}
      {state === 'unavailable' ? (
        <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground">
          <Icon name="lock" size={20} />
          This is not available right now.
        </p>
      ) : null}
      {footer && state === 'content' ? <div className="border-t border-border pt-3 text-ui">{footer}</div> : null}
    </section>
  );
}
