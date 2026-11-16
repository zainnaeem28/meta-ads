'use client';

import { Button } from '../cmp-003/Button';

export interface PaginationProps {
  /** One-based page. */
  page: number;
  pageSize: number;
  /** Rows across all pages. */
  total: number;
  onPageChange: (page: number) => void;
}

/** CMP-017 pagination: "n rows" and named Previous/Next buttons that disable at the ends. */
export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 text-ui text-muted-foreground"
    >
      <span role="status">{total === 1 ? '1 row' : `${total} rows`}</span>
      <div className="inline-flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
