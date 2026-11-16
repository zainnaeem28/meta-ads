import { randomUUID } from 'node:crypto';
import type { RuleResult } from './rules.ts';

// The two outbound sinks of `monitor`. Neither ever carries a token, a URL or a response body: an event is the rule ID
// and numbers only (DEVOPS-PLAN 11.4), and a delivery failure is reported by a fixed code, never by the library message
// (which could contain the DSN or heartbeat URL).

export interface Sink {
  /** True when the event was delivered or the sink is off; false when delivery failed. */
  report(result: RuleResult, environment: string | undefined): Promise<boolean>;
  heartbeat(): Promise<boolean>;
}

interface ParsedDsn {
  endpoint: string;
  key: string;
}

export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const project = url.pathname.split('/').filter(Boolean).pop();
    if (url.username === '' || project === undefined || !/^[0-9]+$/.test(project)) return null;
    return { endpoint: `${url.protocol}//${url.host}/api/${project}/envelope/`, key: url.username };
  } catch {
    return null;
  }
}

export function sentryEnvelope(
  result: RuleResult,
  environment: string | undefined,
  now: Date = new Date(),
): string {
  const eventId = randomUUID().replaceAll('-', '');
  const event = {
    event_id: eventId,
    timestamp: now.toISOString(),
    platform: 'node',
    level: result.severity === 'page-worthy' ? 'error' : 'warning',
    logger: 'monitor',
    message: `${result.rule} ${result.state}`,
    tags: { rule: result.rule, severity: result.severity, service: 'monitor' },
    extra: result.numbers,
    ...(environment === undefined ? {} : { environment }),
    // One issue per rule: no stack, no request, no user.
    fingerprint: [result.rule],
  };
  const header = { event_id: eventId, sent_at: now.toISOString() };
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
}

async function post(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

export interface SinkConfig {
  sentryDsn?: string | undefined;
  heartbeatUrl?: string | undefined;
  fetchImpl?: typeof fetch;
}

export function createSink(config: SinkConfig): Sink {
  const fetchImpl = config.fetchImpl ?? fetch;
  // The adapter stays off until the vendor record exists (T-14): no DSN, no event, no error.
  const dsn =
    config.sentryDsn === undefined || config.sentryDsn === '' ? null : parseDsn(config.sentryDsn);
  return {
    async report(result, environment) {
      if (config.sentryDsn === undefined || config.sentryDsn === '') return true;
      if (dsn === null) return false;
      return post(
        dsn.endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-sentry-envelope',
            'x-sentry-auth': `Sentry sentry_version=7, sentry_client=shroomap-monitor/1, sentry_key=${dsn.key}`,
          },
          body: sentryEnvelope(result, environment),
        },
        fetchImpl,
      );
    },
    async heartbeat() {
      if (config.heartbeatUrl === undefined || config.heartbeatUrl === '') return true;
      return post(config.heartbeatUrl, { method: 'GET' }, fetchImpl);
    },
  };
}
