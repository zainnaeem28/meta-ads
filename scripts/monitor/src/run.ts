import { evaluateAll, telemetryMissing } from './rules.ts';
import type { RuleResult, Thresholds } from './rules.ts';
import { readWindow } from './reader.ts';
import type { Sink } from './sinks.ts';

export interface RunInput {
  apiUrl: string;
  metricsToken: string;
  thresholds: Thresholds;
  sink: Sink;
  environment?: string | undefined;
  fetchImpl?: typeof fetch;
  log: (line: string) => void;
}

export interface RunReport {
  results: RuleResult[];
  alerts: string[];
  delivered: boolean;
  heartbeat: boolean;
}

/**
 * One run, from nothing: read API-903 once, evaluate, send one event per alerting rule, then ping the dead-man heartbeat.
 * A failed read is ALR-9 and the other rules are not evaluated from that run. Recovery sends nothing (the vendor
 * resolves the issue). The heartbeat says "this run completed", so it is sent after alerts as well.
 */
export async function run(input: RunInput): Promise<RunReport> {
  const read = await readWindow(
    input.apiUrl,
    input.metricsToken,
    input.thresholds['ALR-9'].timeoutMs,
    input.fetchImpl,
  );
  const results = read.ok
    ? evaluateAll(read.window, input.thresholds)
    : [telemetryMissing(read.reason)];
  let delivered = true;
  const alerts: string[] = [];
  for (const result of results) {
    if (result.state !== 'alert') continue;
    alerts.push(result.rule);
    if (!(await input.sink.report(result, input.environment))) delivered = false;
  }
  input.log(JSON.stringify({ service: 'monitor', msg: 'monitor run', results, delivered }));
  const heartbeat = await input.sink.heartbeat();
  return { results, alerts, delivered, heartbeat };
}
