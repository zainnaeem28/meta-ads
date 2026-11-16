import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetricsWindow } from './window.ts';

// ALR-2, ALR-3, ALR-7 and ALR-9 of DEVOPS-PLAN 11.3, evaluated from ONE reading of API-903 (11.4): no stored state, no
// database. Thresholds are data (infra/monitoring/alerts.json).

export type RuleState = 'alert' | 'ok' | 'recovered' | 'insufficient_data';
export type RuleId = 'ALR-2' | 'ALR-3' | 'ALR-7' | 'ALR-9';

/** Only the rule, its state and numbers: this object is the whole content of a Sentry event and of the log line. */
export interface RuleResult {
  rule: RuleId;
  state: RuleState;
  severity: 'page-worthy' | 'ticket';
  numbers: Record<string, number | null>;
}

export interface Thresholds {
  'ALR-2': { minRequests: number; maxRatio: number; recoveryRatio: number };
  'ALR-3': { minRequests: number; maxP95Ms: number };
  'ALR-7': { minAcquisitions: number; maxP95WaitMs: number };
  'ALR-9': { timeoutMs: number };
}

export const ALERTS_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'infra',
  'monitoring',
  'alerts.json',
);

export function loadThresholds(path: string = ALERTS_PATH): Thresholds {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as {
    alerts: { id: string; params?: Record<string, number> }[];
  };
  const params = (id: string): Record<string, number> => {
    const found = doc.alerts.find((a) => a.id === id)?.params;
    if (found === undefined) throw new Error(`alerts.json has no params for ${id}`);
    return found;
  };
  const p2 = params('ALR-2');
  const p3 = params('ALR-3');
  const p7 = params('ALR-7');
  const p9 = params('ALR-9');
  const need = (value: number | undefined, name: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`alerts.json: ${name} is not a number`);
    return value;
  };
  return {
    'ALR-2': {
      minRequests: need(p2['minRequests'], 'ALR-2.minRequests'),
      maxRatio: need(p2['maxRatio'], 'ALR-2.maxRatio'),
      recoveryRatio: need(p2['recoveryRatio'], 'ALR-2.recoveryRatio'),
    },
    'ALR-3': {
      minRequests: need(p3['minRequests'], 'ALR-3.minRequests'),
      maxP95Ms: need(p3['maxP95Ms'], 'ALR-3.maxP95Ms'),
    },
    'ALR-7': {
      minAcquisitions: need(p7['minAcquisitions'], 'ALR-7.minAcquisitions'),
      maxP95WaitMs: need(p7['maxP95WaitMs'], 'ALR-7.maxP95WaitMs'),
    },
    'ALR-9': { timeoutMs: need(p9['timeoutMs'], 'ALR-9.timeoutMs') },
  };
}

export function evaluate5xx(window: MetricsWindow, t: Thresholds['ALR-2']): RuleResult {
  const [w10, w15] = window.windows;
  const numbers = {
    requests10m: w10.requests,
    errors5xx10m: w10.errors5xx,
    requests15m: w15.requests,
    errors5xx15m: w15.errors5xx,
  };
  const base = { rule: 'ALR-2', severity: 'page-worthy', numbers } as const;
  if (w10.requests >= t.minRequests) {
    return { ...base, state: w10.errors5xx / w10.requests > t.maxRatio ? 'alert' : 'ok' };
  }
  // The alert window has too few requests: recovery is read from the 15-minute window, else there is no signal.
  if (w15.requests >= t.minRequests && w15.errors5xx / w15.requests < t.recoveryRatio)
    return { ...base, state: 'recovered' };
  return { ...base, state: 'insufficient_data' };
}

export function evaluateLatency(window: MetricsWindow, t: Thresholds['ALR-3']): RuleResult {
  const w15 = window.windows[1];
  const base = {
    rule: 'ALR-3',
    severity: 'ticket',
    numbers: { requests15m: w15.requests, p95Ms15m: w15.p95Ms },
  } as const;
  if (w15.requests < t.minRequests || w15.p95Ms === null)
    return { ...base, state: 'insufficient_data' };
  return { ...base, state: w15.p95Ms > t.maxP95Ms ? 'alert' : 'recovered' };
}

export function evaluatePool(window: MetricsWindow, t: Thresholds['ALR-7']): RuleResult {
  const pool = window.poolWait;
  const base = {
    rule: 'ALR-7',
    severity: 'ticket',
    numbers: {
      acquisitions10m: pool.acquisitions,
      waited10m: pool.waited,
      p95WaitMs10m: pool.p95WaitMs,
    },
  } as const;
  if (pool.acquisitions < t.minAcquisitions || pool.p95WaitMs === null)
    return { ...base, state: 'insufficient_data' };
  return { ...base, state: pool.p95WaitMs > t.maxP95WaitMs ? 'alert' : 'recovered' };
}

/** ALR-9 from a valid body: drops in the last 10 minutes, and no other field (`telemetryDroppedTotal` is not an input). */
export function evaluateTelemetry(window: MetricsWindow): RuleResult {
  return {
    rule: 'ALR-9',
    severity: 'ticket',
    state: window.telemetryDropped10m > 0 ? 'alert' : 'ok',
    numbers: { telemetryDropped10m: window.telemetryDropped10m },
  };
}

/** ALR-9 when the read itself failed; the other rules are not evaluated from that run. `reason` is a fixed code. */
export function telemetryMissing(reason: ReadFailure): RuleResult {
  return {
    rule: 'ALR-9',
    severity: 'ticket',
    state: 'alert',
    numbers: { readFailure: FAILURE_CODES[reason] },
  };
}

export type ReadFailure = 'unreachable' | 'timeout' | 'status' | 'invalid_body';
const FAILURE_CODES: Record<ReadFailure, number> = {
  unreachable: 1,
  timeout: 2,
  status: 3,
  invalid_body: 4,
};

export function evaluateAll(window: MetricsWindow, t: Thresholds): RuleResult[] {
  return [
    evaluate5xx(window, t['ALR-2']),
    evaluateLatency(window, t['ALR-3']),
    evaluatePool(window, t['ALR-7']),
    evaluateTelemetry(window),
  ];
}
