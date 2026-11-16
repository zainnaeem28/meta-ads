'use client';

import { useId, useState } from 'react';
import { Icon } from '../../icons';
import { Button } from '../cmp-003/Button';
import { Badge } from '../cmp-007/Badge';
import { Input } from '../cmp-004/Input';

export type ClaimClass = 'high-risk' | 'other';

export interface ClaimIssueProps {
  claimClass: ClaimClass;
  segment: number;
  /** The text the claim check flagged. */
  quote: string;
  instruction: string;
  /** A closed issue shows no actions. */
  closed?: boolean;
  closedNote?: string;
  /** Called with the trimmed reason; only `other` issues can be cleared. */
  onClear?: (reason: string) => void;
  busy?: boolean;
  className?: string;
}

/** CMP-023 claim issue: high risk has no clear action (edit until the re-check passes); other clears with a reason. */
export function ClaimIssue({
  claimClass,
  segment,
  quote,
  instruction,
  closed = false,
  closedNote = 'Closed',
  onClear,
  busy = false,
  className,
}: ClaimIssueProps) {
  const [reason, setReason] = useState('');
  const id = useId();
  const high = claimClass === 'high-risk';
  const tone = closed
    ? 'border-border bg-muted'
    : high
      ? 'border-destructive-border bg-destructive-subtle'
      : 'border-warning-border bg-warning-subtle';
  const trimmed = reason.trim();
  return (
    <article
      aria-label={`${high ? 'High risk' : 'Other'} claim issue, segment ${segment}`}
      data-class={claimClass}
      data-state={closed ? 'closed' : 'open'}
      className={['flex w-full flex-col gap-3 rounded-lg border p-4 text-ui', tone, className]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Badge
          variant={high ? 'destructive' : 'warning'}
          icon={high ? 'shield-alert' : 'triangle-alert'}
        >
          {high ? 'High risk' : 'Other'}
        </Badge>
        <span className="font-semibold">Segment {segment}</span>
        {closed ? (
          <span className="flex items-center gap-1 text-caption text-muted-foreground">
            <Icon name="circle-check" size={16} /> {closedNote}
          </span>
        ) : null}
      </header>
      <blockquote className="break-words border-l-4 border-border-strong pl-3 italic">
        {quote}
      </blockquote>
      <p className="break-words">{instruction}</p>
      {closed ? null : high ? (
        <p className="text-caption text-muted-foreground">
          This cannot be cleared. Edit the segment until the re-check passes.
        </p>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && !busy) onClear?.(trimmed);
          }}
        >
          <label htmlFor={`${id}-reason`} className="font-semibold">
            Reason for clearing
          </label>
          <Input
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            disabled={busy}
          />
          <div>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={!trimmed || busy}
              aria-label={`Clear issue for segment ${segment}`}
            >
              Clear issue
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}
