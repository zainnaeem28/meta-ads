#!/usr/bin/env node

// Judges a k6 run against baselines.load of config/quality-policy.json and writes the report the gate reads.
// Usage: evaluate.mjs SUMMARY_JSON POOL_JSON OUT_JSON [--smoke]
// A run answered mostly by 401s, or with too few requests, is rejected whatever its latency says (QUALITY-RELEASE-PLAN 6).
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselinePolicy } from '../lib/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [summaryFile, poolFile, outFile, ...flags] = process.argv.slice(2);
const smoke = flags.includes('--smoke');
const { baselines } = baselinePolicy();
const target = baselines.load;
const data = JSON.parse(readFileSync(summaryFile, 'utf8'));
const pool = JSON.parse(readFileSync(poolFile, 'utf8'));
const metric = (name) => data.metrics[name]?.values ?? {};
const count = (name) => metric(name).count ?? 0;

const requests = count('model_requests');
const p95 = metric('interactive_duration')['p(95)'];
const unauthorized = count('status_401');
const unexpected = count('status_unexpected');
const capacityFailures = count('status_capacity');
const serverErrors = count('status_5xx');
const unauthorizedShare = requests ? unauthorized / requests : 1;
const errorRate = requests ? unexpected / requests : 1;
const seconds = (data.state?.testRunDurationMs ?? 0) / 1000;

const checks = [
  {
    name: 'enough requests answered',
    ok: requests >= (smoke ? 20 : target.minRequests),
    detail: `${requests} requests`,
  },
  {
    name: 'run not answered by 401s',
    ok: unauthorizedShare <= target.maxUnauthorizedShare,
    detail: `${(unauthorizedShare * 100).toFixed(1)}% of requests were 401 (limit ${(target.maxUnauthorizedShare * 100).toFixed(0)}%): the run is not counted when the sessions were refused`,
  },
  {
    name: `p95 <= ${target.p95Ms} ms`,
    ok: p95 !== undefined && p95 <= target.p95Ms,
    detail: `p95 ${p95?.toFixed(1)} ms`,
  },
  {
    name: `error rate < ${target.maxErrorRate * 100}%`,
    ok: errorRate < target.maxErrorRate,
    detail: `${(errorRate * 100).toFixed(2)}% (${unexpected} of ${requests})`,
  },
  {
    name: 'zero failures caused by capacity',
    ok: capacityFailures === 0 && serverErrors === 0,
    detail: `${capacityFailures} capacity answers (429/502/503/504), ${serverErrors} server errors`,
  },
];
const ok = checks.every((c) => c.ok);
const report = {
  tool: 'k6',
  toolVersion: process.env.K6_VERSION ?? null,
  target: { ...target, run: smoke ? 'smoke (not a baseline)' : 'scaled-down NFR-01 target' },
  mode: smoke ? 'smoke' : 'scaled',
  durationSeconds: seconds,
  requests,
  throughputPerSecond: requests / (seconds || 1),
  latencyMs: {
    avg: metric('interactive_duration').avg,
    med: metric('interactive_duration').med,
    p95,
    p99: metric('interactive_duration')['p(99)'],
    max: metric('interactive_duration').max,
  },
  status: { unauthorized, unexpected, capacity: capacityFailures, serverErrors },
  actions: { reads: count('read_actions'), writes: count('write_actions') },
  dbPool: pool,
  checks,
  result: ok ? 'pass' : 'fail',
};
writeFileSync(outFile, JSON.stringify(report, null, 2));
const results = join(here, '..', 'lib', 'results.mjs');
spawnSync('node', [results, 'reset', 'load']);
for (const c of checks)
  spawnSync('node', [
    results,
    'add',
    'load',
    `TC-NFR-01 ${c.name}`,
    c.ok ? 'pass' : 'fail',
    c.detail,
    String(seconds),
  ]);
process.stdout.write(
  `${checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n')}\nload: ${ok ? 'pass' : 'FAIL'}\n`,
);
process.exit(ok ? 0 : 1);
