import { createScrubber, scrubReportEvent } from '../logging/redact.js';
import type { Scrubber } from '../logging/redact.js';

/** The slice of `@sentry/node` the adapter uses, so tests (and a missing vendor) need no network or package. */
export interface SentrySdk {
  init(options: Record<string, unknown>): unknown;
  getClient?(): { on?(hook: string, callback: (...args: unknown[]) => void): unknown } | undefined;
  captureException(error: unknown): unknown;
  close?(timeoutMs?: number): Promise<unknown>;
}

export interface SentryConfig {
  SENTRY_DSN?: string | undefined;
  SENTRY_ENVIRONMENT?: string | undefined;
  SENTRY_ERRORS_SAMPLE_RATE?: number | undefined;
  SENTRY_TRACES_SAMPLE_RATE?: number | undefined;
  RELEASE_SHA?: string | undefined;
}

export interface SentryAdapter {
  captureException(error: unknown): void;
  close(): Promise<void>;
}

export interface SentryDeps {
  sdk: SentrySdk;
  scrub?: Scrubber | undefined;
  onDropped: (count?: number) => void;
}

/**
 * The beforeSend / beforeBreadcrumb hook: the report is rebuilt from a scrubbed copy and request bodies, cookies and
 * user data are removed outright. A hook failure drops the event (counted) rather than sending an unscrubbed one.
 */
export function createScrubHook(scrub: Scrubber, onDropped: () => void): <T extends object>(event: T) => T | null {
  return <T extends object>(event: T): T | null => {
    try {
      const copy = scrubReportEvent(event, scrub) as Record<string, unknown>;
      delete copy['user'];
      const request = copy['request'] as Record<string, unknown> | undefined;
      if (request !== undefined && request !== null) {
        delete request['data'];
        delete request['cookies'];
        delete request['headers'];
        delete request['query_string'];
      }
      return copy as T;
    } catch {
      onDropped();
      return null;
    }
  };
}

/**
 * The error-reporter adapter. Off (returns null, nothing is loaded or sent) until `SENTRY_DSN` is set, which happens
 * only after the vendor is recorded (T-14).
 */
export function createSentryAdapter(config: SentryConfig, deps: SentryDeps): SentryAdapter | null {
  if (config.SENTRY_DSN === undefined || config.SENTRY_DSN === '') return null;
  const scrub = deps.scrub ?? createScrubber();
  const hook = createScrubHook(scrub, () => deps.onDropped());
  deps.sdk.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    release: config.RELEASE_SHA,
    sampleRate: config.SENTRY_ERRORS_SAMPLE_RATE ?? 1,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE ?? 0,
    sendDefaultPii: false,
    beforeSend: hook,
    beforeBreadcrumb: hook,
    beforeSendTransaction: hook,
  });
  // A delivery the vendor refused or could not make is a dropped event (ALR-9).
  deps.sdk.getClient?.()?.on?.('afterSendEvent', (_event: unknown, response: unknown) => {
    const code = (response as { statusCode?: unknown } | undefined)?.statusCode;
    if (typeof code !== 'number' || code >= 400) deps.onDropped();
  });
  return {
    captureException(error) {
      try {
        deps.sdk.captureException(error);
      } catch {
        deps.onDropped();
      }
    },
    async close() {
      await deps.sdk.close?.(2000);
    },
  };
}
