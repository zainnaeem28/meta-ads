import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/**
 * False on the server and during the hydrating render, true on every render after. Labels that depend on the visitor's
 * time zone, locale or clock render a same-size placeholder until it is true, so the server's HTML and the first client
 * render are identical (ADR-014, constraint 8). Never a per-screen effect flag.
 */
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
