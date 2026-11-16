import type { ElementType, HTMLAttributes } from 'react';

type ElementProps = Omit<HTMLAttributes<HTMLElement>, 'as'>;

export const GRID_SPANS = [3, 4, 6, 8, 12] as const;
export type GridSpan = (typeof GRID_SPANS)[number];

// Literal class names so Tailwind can see them. Under 768 px every column is full width.
const SPAN: Record<GridSpan, string> = {
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  6: 'md:col-span-6',
  8: 'md:col-span-8',
  12: 'md:col-span-12',
};

export interface PageGridProps extends ElementProps {
  /** Tag of the grid element; default `div`. */
  as?: 'div' | 'section' | 'ul';
}

/** CMP-034: 12-column grid, one column under 768 px; gutter 16 px, 24 px from 1024 px. */
export function PageGrid({ as = 'div', className, ...rest }: PageGridProps) {
  const Tag: ElementType = as;
  const classes = ['grid grid-cols-1 gap-4 md:grid-cols-12 lg:gap-6', className].filter(Boolean).join(' ');
  return <Tag className={classes} data-page-grid="" {...rest} />;
}

export interface GridColProps extends ElementProps {
  /** Columns spanned from 768 px up; default 12. */
  span?: GridSpan;
  as?: 'div' | 'li' | 'section';
}

/** A column of the page grid (`col-3/4/6/8/12`). */
export function GridCol({ span = 12, as = 'div', className, ...rest }: GridColProps) {
  const Tag: ElementType = as;
  const classes = ['min-w-0', SPAN[span], className].filter(Boolean).join(' ');
  return <Tag className={classes} data-span={span} {...rest} />;
}
