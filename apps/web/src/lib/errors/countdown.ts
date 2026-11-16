'use client';

import { useEffect, useRef, useState } from 'react';
import { waitPhrase } from './copy';

/** Wait used when the answer carries no `Retry-After` (UI-UX §9.1 retry presentation (2)). */
export const DEFAULT_WAIT_SECONDS = 5;
/** Above this many seconds the label counts in minutes. */
export const MINUTES_ABOVE_SECONDS = 120;

/** Button label while waiting: "Try again in 12s", or in minutes above 120 seconds. */
export const waitLabel = (remaining: number): string =>
  remaining > MINUTES_ABOVE_SECONDS
    ? `Try again in ${Math.ceil(remaining / 60)} min`
    : `Try again in ${remaining}s`;

export interface RetryCountdown {
  remaining: number;
  ready: boolean;
  /** Changes only at the start and when the wait ends: the text for the live region. */
  announcement: string;
}

/**
 * Counts `seconds` down once a second. The announcement changes twice only (start and availability), never per
 * second, so a screen reader is not interrupted. `restartKey` starts a new wait for a new failure.
 */
export function useRetryCountdown(seconds: number, restartKey: unknown = 0): RetryCountdown {
  const [remaining, setRemaining] = useState(seconds);
  const [announcement, setAnnouncement] = useState(
    seconds > 0 ? `You can try again in ${waitPhrase(seconds)}.` : '',
  );
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
    } else {
      setRemaining(seconds);
      setAnnouncement(seconds > 0 ? `You can try again in ${waitPhrase(seconds)}.` : '');
    }
    if (seconds <= 0) return undefined;
    const started = Date.now();
    const timer = setInterval(() => {
      const left = Math.max(0, seconds - Math.floor((Date.now() - started) / 1000));
      setRemaining(left);
      if (left === 0) {
        setAnnouncement('You can try again now.');
        clearInterval(timer);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [seconds, restartKey]);

  return { remaining, ready: remaining <= 0, announcement };
}

/** Consecutive failures of Try again; three show the "contact your administrator" hint. */
export const FAILURE_HINT_AT = 3;

export function useRetryFailures() {
  const [failures, setFailures] = useState(0);
  return {
    failures,
    recordFailure: () => setFailures((n) => n + 1),
    recordSuccess: () => setFailures(0),
  };
}
