// MetricsWindowResponse of API-903 (OpenAPI design.5), validated by hand: monitor has no dependency and a body that does
// not fit the schema is the ALR-9 signal, never a crash and never a partial read.

export interface WindowSample {
  minutes: 10 | 15;
  requests: number;
  errors5xx: number;
  p95Ms: number | null;
}

export interface PoolWait {
  acquisitions: number;
  waited: number;
  p95WaitMs: number | null;
}

export interface MetricsWindow {
  windows: [WindowSample, WindowSample];
  poolWait: PoolWait;
  telemetryDropped10m: number;
  telemetryDroppedTotal: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNullableMs = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const isInstant = (v: unknown): boolean => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function sample(value: unknown, minutes: 10 | 15): WindowSample | null {
  if (!isObject(value) || value['minutes'] !== minutes) return null;
  if (!isInstant(value['from']) || !isInstant(value['to'])) return null;
  const { requests, errors5xx, p95Ms } = value;
  if (!isCount(requests) || !isCount(errors5xx) || !isNullableMs(p95Ms)) return null;
  return { minutes, requests, errors5xx, p95Ms };
}

/** Returns the parsed window, or null when the body is not a valid MetricsWindowResponse. */
export function parseMetricsWindow(body: unknown): MetricsWindow | null {
  if (!isObject(body) || body['success'] !== true || !isObject(body['metaData'])) return null;
  const data = body['data'];
  if (!isObject(data) || !isInstant(data['processStartedAt'])) return null;
  const windows = data['windows'];
  if (!Array.isArray(windows) || windows.length !== 2) return null;
  const w10 = sample(windows[0], 10);
  const w15 = sample(windows[1], 15);
  const pool = data['poolWait'];
  if (w10 === null || w15 === null || !isObject(pool) || pool['minutes'] !== 10) return null;
  const { acquisitions, waited, p95WaitMs } = pool;
  if (!isCount(acquisitions) || !isCount(waited) || !isNullableMs(p95WaitMs)) return null;
  const { telemetryDropped10m, telemetryDroppedTotal } = data;
  if (!isCount(telemetryDropped10m) || !isCount(telemetryDroppedTotal)) return null;
  return {
    windows: [w10, w15],
    poolWait: { acquisitions, waited, p95WaitMs },
    telemetryDropped10m,
    telemetryDroppedTotal,
  };
}
