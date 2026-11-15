import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRender, type Options } from './fake-render.ts';
import { run } from './harness.ts';
import { join } from 'node:path';
import { repoRoot } from './trace.ts';

const observeScript = join(repoRoot, 'scripts/ci/observe.sh');

let fake: FakeRender | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

async function observe(options: Options, extra: Record<string, string> = {}) {
  fake = await new FakeRender(options).start();
  const result = await run(observeScript, [], {
    OBSERVE_API_URL: fake.url,
    METRICS_TOKEN: 'metrics-token',
    OBSERVE_WINDOW_SECONDS: '0',
    OBSERVE_INTERVAL_SECONDS: '0',
    ...extra,
  });
  return { f: fake, result };
}

const healthy = {
  requests: 1000,
  errors5xx: 5,
  p95Ms: 150,
  stuckSubmitting: 0,
  kekUnsealFailures: 0,
  workerHeartbeatAgeSeconds: 60,
};

describe('observe.sh', () => {
  it('passes a healthy window and reads the metrics with the token', async () => {
    const { f, result } = await observe({ metrics: healthy }, { OBSERVE_BASELINE_P95_MS: '100' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('window of 0s passed in 1 round(s)');
    expect(f.calls('GET', /metrics/)[0]?.auth).toBe('Bearer metrics-token');
  });

  it('keeps probing for the whole window', async () => {
    const { result } = await observe(
      { metrics: { requests: 3 } },
      { OBSERVE_WINDOW_SECONDS: '2', OBSERVE_INTERVAL_SECONDS: '0.5' },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/passed in [2-9] round/);
  });

  it('needs the api url, the token and the tools', async () => {
    expect((await run(observeScript, [], { METRICS_TOKEN: 'x' })).code).toBe(64);
    expect((await run(observeScript, [], { OBSERVE_API_URL: 'http://x' })).code).toBe(64);
    const bin = mkdtempSync(join(tmpdir(), 'bash-only-'));
    symlinkSync(execFileSync('which', ['bash']).toString().trim(), join(bin, 'bash'));
    const noTools = await run(observeScript, [], {
      OBSERVE_API_URL: 'http://x',
      METRICS_TOKEN: 'x',
      PATH: bin,
    });
    expect(noTools.code).toBe(69);
  });

  it('aborts after three failed readiness probes in a row, not after two', async () => {
    const aborted = await observe({ health: [503] }, { OBSERVE_WINDOW_SECONDS: '60' });
    expect(aborted.result.code).toBe(1);
    expect(aborted.result.stderr).toContain('/health/ready failed 3 probes in a row');
    const recovered = await observe(
      { health: [503, 503, 200], metrics: {} },
      { OBSERVE_WINDOW_SECONDS: '1', OBSERVE_INTERVAL_SECONDS: '0.3' },
    );
    expect(recovered.result.code).toBe(0);
  });

  it('aborts on a 5xx ratio over 2% with at least 100 requests', async () => {
    const { result } = await observe({ metrics: { requests: 500, errors5xx: 11 } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('5xx ratio over 0.02 with 500 requests');
  });

  it('does not abort on a single failed request in a small sample', async () => {
    const { result } = await observe({ metrics: { requests: 20, errors5xx: 5 } });
    expect(result.code).toBe(0);
  });

  it('aborts when p95 is over twice the baseline with at least 200 requests', async () => {
    const slow = await observe(
      { metrics: { requests: 300, p95Ms: 250 } },
      { OBSERVE_BASELINE_P95_MS: '100' },
    );
    expect(slow.result.code).toBe(1);
    expect(slow.result.stderr).toContain('p95 250 ms is over 2x the 100 ms baseline');
    const small = await observe(
      { metrics: { requests: 150, p95Ms: 900 } },
      { OBSERVE_BASELINE_P95_MS: '100' },
    );
    expect(small.result.code).toBe(0);
    const edge = await observe(
      { metrics: { requests: 300, p95Ms: 200 } },
      { OBSERVE_BASELINE_P95_MS: '100' },
    );
    expect(edge.result.code).toBe(0);
  });

  it('refuses to judge p95 without a baseline', async () => {
    const { result } = await observe({ metrics: { requests: 300, p95Ms: 10 } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OBSERVE_BASELINE_P95_MS is required');
  });

  it('aborts on stuck jobs, a KEK unseal failure and a silent worker', async () => {
    const stuck = await observe({ metrics: { stuckSubmitting: 2 } });
    expect(stuck.result.stderr).toContain('2 job(s) stuck in submitting');
    const kek = await observe({ metrics: { kekUnsealFailures: 1 } });
    expect(kek.result.stderr).toContain('KEK unseal failure alert fired');
    const silent = await observe({ metrics: { workerHeartbeatAgeSeconds: 901 } });
    expect(silent.result.stderr).toContain('worker heartbeat is 901 s old');
    expect([stuck, kek, silent].map((o) => o.result.code)).toEqual([1, 1, 1]);
  });

  it('aborts when the metrics cannot be read, because the window cannot be judged', async () => {
    const { result } = await observe({ metricsStatus: 401 });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('metrics summary cannot be read');
  });
});
