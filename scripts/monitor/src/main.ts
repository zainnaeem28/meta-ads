import process from 'node:process';
import { loadThresholds } from './rules.ts';
import { run } from './run.ts';
import { createSink } from './sinks.ts';

// ops-cli monitor: `node scripts/monitor/src/main.ts --api-url <private URL of the api> [--timeout-ms N]`.
// Environment: METRICS_TOKEN (required), SENTRY_DSN and SENTRY_ENVIRONMENT (optional; no DSN keeps Sentry off),
// HEARTBEAT_URL_MONITOR (optional). Exit 0 after a completed run, alerts included; 64 for a configuration fault.

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const apiUrl = argument('--api-url');
const token = process.env['METRICS_TOKEN'] ?? '';
if (apiUrl === undefined || !URL.canParse(apiUrl) || token === '') {
  process.stderr.write('monitor: --api-url (a URL) and METRICS_TOKEN are required\n');
  process.exit(64);
}

const thresholds = loadThresholds();
const timeout = Number(argument('--timeout-ms'));
if (Number.isFinite(timeout) && timeout > 0) thresholds['ALR-9'].timeoutMs = timeout;

const report = await run({
  apiUrl,
  metricsToken: token,
  thresholds,
  sink: createSink({
    sentryDsn: process.env['SENTRY_DSN'],
    heartbeatUrl: process.env['HEARTBEAT_URL_MONITOR'],
  }),
  environment: process.env['SENTRY_ENVIRONMENT'] || process.env['APP_ENV'] || undefined,
  log: (line) => process.stdout.write(`${line}\n`),
});
if (!report.delivered) process.stderr.write('monitor: an alert event could not be delivered\n');
if (!report.heartbeat) process.stderr.write('monitor: the heartbeat ping failed\n');
