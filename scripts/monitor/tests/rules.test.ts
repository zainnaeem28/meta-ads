import { describe, expect, it } from 'vitest';
import {
  evaluate5xx,
  evaluateAll,
  evaluateLatency,
  evaluatePool,
  evaluateTelemetry,
  loadThresholds,
} from '../src/rules.ts';
import { parseMetricsWindow } from '../src/window.ts';
import { body } from './support/stubs.ts';
import type { Sample } from './support/stubs.ts';

// TC-ALR-04 (ALR-2, ALR-3), TC-ALR-05 (ALR-7), TC-ALR-06 (ALR-9, valid bodies): each case is one reading.

const t = loadThresholds();
const none: Sample = { requests: 0, errors5xx: 0, p95Ms: null };
const win = (o: Parameters<typeof body>[0]) => {
  const parsed = parseMetricsWindow(body(o));
  if (parsed === null) throw new Error('fixture does not fit MetricsWindowResponse');
  return parsed;
};
const s = (requests: number, errors5xx: number, p95Ms: number | null = 100): Sample => ({
  requests,
  errors5xx,
  p95Ms,
});

describe('ALR-2 elevated 5xx (TC-ALR-04 a to d)', () => {
  it('(a) 99 requests with 50 errors is insufficient data: not green, not an alert', () => {
    expect(evaluate5xx(win({ w10: s(99, 50), w15: s(99, 50) }), t['ALR-2']).state).toBe(
      'insufficient_data',
    );
  });
  it('(b) 100 requests, 2 errors (2%) is not over the threshold', () => {
    expect(evaluate5xx(win({ w10: s(100, 2), w15: s(100, 2) }), t['ALR-2']).state).toBe('ok');
  });
  it('(c) 100 requests, 3 errors alerts and the result holds numbers only', () => {
    const result = evaluate5xx(win({ w10: s(100, 3), w15: s(100, 3) }), t['ALR-2']);
    expect(result.state).toBe('alert');
    expect(result.severity).toBe('page-worthy');
    expect(Object.values(result.numbers).every((v) => typeof v === 'number')).toBe(true);
  });
  it('(d) recovery is read from windows[1]: 100+ requests below 1% is recovered, 1% to 2% is neither, 99 requests is insufficient', () => {
    expect(evaluate5xx(win({ w10: s(10, 0), w15: s(100, 0) }), t['ALR-2']).state).toBe('recovered');
    expect(evaluate5xx(win({ w10: s(10, 0), w15: s(200, 3) }), t['ALR-2']).state).toBe(
      'insufficient_data',
    );
    expect(evaluate5xx(win({ w10: s(10, 0), w15: s(99, 0) }), t['ALR-2']).state).toBe(
      'insufficient_data',
    );
    expect(evaluate5xx(win({ w10: s(10, 0), w15: s(100, 50) }), t['ALR-2']).state).toBe(
      'insufficient_data',
    );
  });
});

describe('ALR-3 latency (TC-ALR-04 e to h)', () => {
  it('(e) 199 requests with p95 900 is insufficient data', () => {
    expect(evaluateLatency(win({ w10: none, w15: s(199, 0, 900) }), t['ALR-3']).state).toBe(
      'insufficient_data',
    );
  });
  it('(f) 200 requests with p95 501 alerts; 500 is not over', () => {
    expect(evaluateLatency(win({ w10: none, w15: s(200, 0, 501) }), t['ALR-3']).state).toBe(
      'alert',
    );
    expect(evaluateLatency(win({ w10: none, w15: s(200, 0, 500) }), t['ALR-3']).state).toBe(
      'recovered',
    );
  });
  it('(g) p95 null is no alert and no error', () => {
    expect(evaluateLatency(win({ w10: none, w15: s(300, 0, null) }), t['ALR-3']).state).toBe(
      'insufficient_data',
    );
  });
  it('(h) 200 requests with p95 500 or below is recovered (one reading)', () => {
    expect(evaluateLatency(win({ w10: none, w15: s(200, 0, 120) }), t['ALR-3']).state).toBe(
      'recovered',
    );
  });
});

describe('ALR-7 database pressure (TC-ALR-05)', () => {
  it('above the threshold alerts at ticket severity, below it is recovered', () => {
    const above = evaluatePool(
      win({ w10: none, w15: none, pool: { acquisitions: 50, waited: 20, p95WaitMs: 251 } }),
      t['ALR-7'],
    );
    expect(above).toMatchObject({ state: 'alert', severity: 'ticket' });
    expect(
      evaluatePool(
        win({ w10: none, w15: none, pool: { acquisitions: 50, waited: 20, p95WaitMs: 250 } }),
        t['ALR-7'],
      ).state,
    ).toBe('recovered');
  });
  it('0 acquisitions or a null p95 is neither an alert nor an error', () => {
    expect(
      evaluatePool(
        win({ w10: none, w15: none, pool: { acquisitions: 0, waited: 0, p95WaitMs: 900 } }),
        t['ALR-7'],
      ).state,
    ).toBe('insufficient_data');
    expect(
      evaluatePool(
        win({ w10: none, w15: none, pool: { acquisitions: 9, waited: 0, p95WaitMs: null } }),
        t['ALR-7'],
      ).state,
    ).toBe('insufficient_data');
  });
});

describe('ALR-9 from a valid body (TC-ALR-06 e, f)', () => {
  it('alerts on telemetryDropped10m above 0 and on no other field', () => {
    expect(
      evaluateTelemetry(win({ w10: none, w15: none, dropped10m: 3, droppedTotal: 3 })).state,
    ).toBe('alert');
    expect(
      evaluateTelemetry(win({ w10: none, w15: none, dropped10m: 0, droppedTotal: 4 })).state,
    ).toBe('ok');
    expect(evaluateTelemetry(win({ w10: none, w15: none })).state).toBe('ok');
  });
  it('a body after an api restart (total back at 0) is no alert and no error', () => {
    const results = evaluateAll(win({ w10: none, w15: none, dropped10m: 0, droppedTotal: 0 }), t);
    expect(results.find((r) => r.rule === 'ALR-9')?.state).toBe('ok');
  });
});

describe('MetricsWindowResponse parsing', () => {
  it('rejects bodies that do not fit the schema', () => {
    const good = body({ w10: none, w15: none }) as { data: Record<string, unknown> };
    type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const mutate = (fn: (d: Loose) => void): unknown => {
      const copy = JSON.parse(JSON.stringify(good)) as { data: Loose };
      fn(copy.data);
      return copy;
    };
    expect(parseMetricsWindow(good)).not.toBeNull();
    for (const bad of [
      null,
      [],
      { success: true },
      mutate((d) => delete d['telemetryDropped10m']),
      mutate((d) => (d['windows'] = d['windows'].reverse())),
      mutate((d) => (d['windows'] = [d['windows'][0]])),
      mutate((d) => (d['windows'][0].requests = -1)),
      mutate((d) => (d['windows'][0].p95Ms = 'fast')),
      mutate((d) => (d['poolWait'].minutes = 15)),
      mutate((d) => (d['processStartedAt'] = 'not a date')),
      mutate((d) => (d['telemetryDroppedTotal'] = 1.5)),
    ])
      expect(parseMetricsWindow(bad)).toBeNull();
  });
});
