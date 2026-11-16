'use client';

import { Button } from '@shroomap/ui/cmp-003';
import { useRetryCountdown, waitLabel } from '../../lib/errors/countdown';

export interface RetryButtonProps {
  /** Seconds the button stays disabled (`Retry-After`; 5 without it; 0 for an immediate retry). */
  waitSeconds: number;
  /** A new value starts a new wait (a new failure). */
  restartKey?: unknown;
  /** The retry is in flight. */
  pending?: boolean;
  onRetry: () => void;
}

/**
 * Try again with a live countdown: disabled and labelled "Try again in {n}s" (minutes above 120 s) while waiting.
 * The visible label updates every second; the live region speaks only at the start and when the wait ends.
 */
export function RetryButton({
  waitSeconds,
  restartKey,
  pending = false,
  onRetry,
}: RetryButtonProps) {
  const { remaining, ready, announcement } = useRetryCountdown(waitSeconds, restartKey);
  return (
    <>
      <Button variant="outline" size="sm" disabled={!ready} pending={pending} onClick={onRetry}>
        {ready ? 'Try again' : waitLabel(remaining)}
      </Button>
      <span role="status" data-testid="retry-announcement" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
