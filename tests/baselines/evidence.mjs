#!/usr/bin/env node
/* global process */
// Builds docs/evidence/TASK-016/baseline.md from the reports of the last baseline runs (tool, version, scope, target, result).
// Usage: evidence.mjs [OUT_FILE]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const reports = process.env.CI_REPORTS_DIR ?? join(root, 'reports');
const out = process.argv[2] ?? join(root, 'docs', 'evidence', 'TASK-016', 'baseline.md');
const read = (rel) =>
  existsSync(join(reports, rel)) ? JSON.parse(readFileSync(join(reports, rel), 'utf8')) : null;
const load = read('baselines/load.json');
const fe = read('baselines/frontend.json');
const zap = read('baselines/zap/contexts.json');
const findings = read('findings/dast.json');
const lines = [];
const row = (...cells) => lines.push(`| ${cells.join(' | ')} |`);

lines.push(
  '# TASK-016 first baseline (DO-10)',
  '',
  `Recorded ${new Date().toISOString()} by \`tests/baselines/evidence.mjs\` from the reports of the runs below. Target: the baseline stack of \`tests/baselines/stack.mjs\` (built api and web on the host, run-suffixed roles and a throwaway database on the shared test PostgreSQL, migrations, reference seed, 25 accounts with 5 running stub jobs each, synthetic sessions). Pass conditions are read from \`config/quality-policy.json\` (\`baselines\`).`,
  '',
);

if (zap) {
  lines.push(
    '## OWASP ZAP baseline (TC-NFR-10)',
    '',
    `Tool: OWASP ZAP ${zap.version} (spider and passive scan, no active attack), contexts anonymous, user and admin. Scope: the stack's api (\`/api/v1\`, every operation of \`packages/contracts/openapi.yaml\` plus real read requests with real identifiers) and web origins only. Blocking severity: policy \`failOn.sources.zap\`.`,
    '',
  );
  row('Context', 'Answered', '2xx', '401 share', 'By status');
  row('---', '---', '---', '---', '---');
  for (const c of zap.contexts)
    row(
      c.context,
      c.answered,
      c.ok2xx,
      `${(c.share401 * 100).toFixed(1)}%`,
      Object.entries(c.byStatus)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
    );
  lines.push('');
  if (findings)
    lines.push(
      `Findings evaluation (\`reports/findings/dast.json\`): ${findings.blocking.length} blocking, ${findings.nonBlocking.length} non-blocking, ${findings.dismissed.length} dismissed by a time-limited disposition (\`config/dispositions.json\`, expires 2026-12-16). ${findings.errors.length ? `Errors: ${findings.errors.join('; ')}` : ''}`,
      '',
    );
  const rules = new Map();
  for (const f of [...findings.blocking, ...findings.dismissed.map((d) => d.finding ?? d)])
    rules.set(`${f.rule}`, f);
  lines.push(
    'Result: ' +
      (zap.result === 'pass'
        ? 'sessions accepted in every authenticated context; '
        : 'SESSION CHECK FAILED; ') +
      'medium findings below are filed as product defects (see Defects).',
    '',
  );
}
if (load) {
  lines.push(
    '## k6 at the scaled-down NFR-01 target (TC-NFR-01)',
    '',
    `Tool: k6 ${load.toolVersion}. Mode: ${load.mode}. Target: ${load.target.accounts} accounts, ${load.target.virtualUsers} virtual users, ${load.target.stubJobsPerAccount} running stub jobs per account, think ${load.target.thinkTimeSec} s, status poll ${load.target.pollIntervalSec} s, ramp ${load.target.rampSec} s, steady ${load.target.steadySec} s, read share ${load.target.readShare}, p95 at most ${load.target.p95Ms} ms, error rate under ${load.target.maxErrorRate * 100}%. Duration ${load.durationSeconds.toFixed(0)} s.`,
    '',
  );
  row('Measure', 'Value');
  row('---', '---');
  row('Requests', load.requests);
  row('Throughput', `${load.throughputPerSecond.toFixed(2)} req/s`);
  row(
    'Latency avg / med / p95 / p99 / max',
    [
      load.latencyMs.avg,
      load.latencyMs.med,
      load.latencyMs.p95,
      load.latencyMs.p99,
      load.latencyMs.max,
    ]
      .map((x) => `${x.toFixed(1)} ms`)
      .join(' / '),
  );
  row('401 answers', load.status.unauthorized);
  row('Unexpected answers', load.status.unexpected);
  row('Capacity answers (429/502/503/504)', load.status.capacity);
  row('5xx', load.status.serverErrors);
  row('Actions read / write', `${load.actions.reads} / ${load.actions.writes}`);
  row(
    'DB connections (api role) max / mean of pool',
    `${load.dbPool.max} / ${load.dbPool.mean.toFixed(1)} of ${load.dbPool.poolMax} (${load.dbPool.samples} samples)`,
  );
  lines.push(
    '',
    ...load.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`),
    '',
    `Result: ${load.result}.`,
    '',
  );
}
if (fe) {
  lines.push(
    '## Lighthouse CI and Playwright web-vitals (TC-NFR-02)',
    '',
    `Tools: Lighthouse ${fe.lighthouseVersion} (${fe.lighthouseBrowser}); Playwright web-vitals on ${fe.playwrightBrowser}. Built production artifact (\`next start\`), ${fe.target.samplesPerRoute} cold samples per route and profile, medians compared. Budgets: LCP at most ${fe.target.lcpMs} ms, INP at most ${fe.target.inpMs} ms, CLS at most ${fe.target.cls}, TBT at most ${fe.target.tbtMs} ms. Mode: ${fe.mode}. Conditions: ${JSON.stringify(fe.conditions)}; Lighthouse simulated throttling of its own mobile and desktop presets; ${fe.concurrency.lighthouse} parallel workers; host ${fe.host ? `${fe.host.cpus} CPUs, 1-minute load ${fe.host.loadStart.toFixed(1)} at start and ${fe.host.loadEnd.toFixed(1)} at the end (a shared, busy host inflates TBT and LCP; the number is recorded, not corrected)` : 'load not recorded'}.`,
    '',
  );
  row('Route', 'Profile', 'LH LCP', 'LH CLS', 'LH TBT', 'PW LCP', 'PW CLS', 'PW INP', 'Result');
  row(...Array(9).fill('---'));
  const f = (x, d = 0) => (x === null || x === undefined ? 'n/o' : x.toFixed(d));
  for (const r of fe.rows)
    row(
      r.route,
      r.profile,
      f(r.lighthouse.lcpMs),
      f(r.lighthouse.cls, 3),
      f(r.lighthouse.tbtMs),
      f(r.playwright.lcpMs),
      f(r.playwright.cls, 3),
      r.playwright.inpMs === null ? '<=16 (below threshold)' : f(r.playwright.inpMs),
      r.result + (r.problems.length ? `: ${r.problems.join('; ')}` : ''),
    );
  lines.push('', `Result: ${fe.result}. n/o = not observed.`, '');
}
lines.push(
  '## Defects filed from this baseline',
  '',
  'See the task comment of TASK-016: each blocking ZAP finding and each budget breach above is filed to its owner by the Orchestrator; this file only records the measurements.',
  '',
);
writeFileSync(out, lines.join('\n'));
process.stdout.write(`wrote ${out}\n`);
