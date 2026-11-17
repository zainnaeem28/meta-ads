#!/usr/bin/env node
/* global process */
// Compares the medians of the Lighthouse and Playwright samples with baselines.frontend of config/quality-policy.json
// and writes the report the gate reads (reports/baselines/frontend.json) and the junit cases.
// Usage: evaluate.mjs LIGHTHOUSE_JSON WEBVITALS_JSON OUT_JSON [--enforce]
// Without --enforce (the first baseline) a budget breach is recorded in the report and the junit as skipped, to be filed as a
// product defect; an invalid run (too few samples, a signed-in route that redirected to sign-in, a tool failure) always fails.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselinePolicy } from '../lib/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [lhFile, pwFile, outFile, ...flags] = process.argv.slice(2);
const enforce = flags.includes('--enforce');
const fe = baselinePolicy().baselines.frontend;
const lh = JSON.parse(readFileSync(lhFile, 'utf8'));
const pw = JSON.parse(readFileSync(pwFile, 'utf8'));

const median = (values) => {
  const v = values
    .filter((x) => x !== null && x !== undefined && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const expectedPath = (route) => route.path.replace('{campaign}', '[^/]+');
const results = join(here, '..', 'lib', 'results.mjs');
const wanted = Math.min(lh.requested ?? fe.samplesPerRoute, pw.requested ?? fe.samplesPerRoute);
const mode =
  wanted >= fe.samplesPerRoute
    ? enforce
      ? 'enforce'
      : 'baseline'
    : 'smoke (fewer samples than the policy, not a baseline)';
spawnSync('node', [results, 'reset', 'frontend']);

const rows = [];
for (const route of fe.routes) {
  for (const profile of fe.profiles) {
    const pick = (set) => set.samples.filter((s) => s.route === route.id && s.profile === profile);
    const L = pick(lh);
    const P = pick(pw);
    const landed = (s) =>
      !s.error && new RegExp(`^${expectedPath(route)}$`).test(s.finalPath ?? '');
    const validL = L.filter(landed);
    const validP = P.filter(landed);
    const row = {
      route: route.id,
      profile,
      samples: { lighthouse: validL.length, playwright: validP.length, wanted },
      lighthouse: {
        lcpMs: median(validL.map((s) => s.lcpMs)),
        cls: median(validL.map((s) => s.cls)),
        tbtMs: median(validL.map((s) => s.tbtMs)),
      },
      playwright: {
        lcpMs: median(validP.map((s) => s.lcpMs)),
        cls: median(validP.map((s) => s.cls)),
        inpMs: median(validP.map((s) => s.inpMs)),
        inpObserved: validP.filter((s) => s.inpMs !== null && s.inpMs !== undefined).length,
      },
    };
    const invalid = [];
    const budget = [];
    if (validL.length < wanted || validP.length < wanted)
      invalid.push(
        `only ${validL.length}/${validP.length} valid samples of ${wanted} (a sample that did not land on the route, for example redirected to sign-in, is not valid)`,
      );
    const over = (name, value, limit) =>
      value === null
        ? budget.push(`${name} not observed`)
        : value > limit &&
          budget.push(`${name} ${value.toFixed(name === 'CLS' ? 3 : 0)} > ${limit}`);
    over('LCP (lighthouse)', row.lighthouse.lcpMs, fe.lcpMs);
    over('LCP (playwright)', row.playwright.lcpMs, fe.lcpMs);
    over('CLS', Math.max(row.lighthouse.cls ?? 0, row.playwright.cls ?? 0), fe.cls);
    over('TBT', row.lighthouse.tbtMs, fe.tbtMs);
    if (row.playwright.inpMs === null && validP.every((x) => x.inputs > 0))
      row.playwright.inpNote =
        'no interaction reached the 16 ms Event Timing threshold: INP is at most 16 ms';
    else over('INP', row.playwright.inpMs, fe.inpMs);
    row.problems = [...invalid, ...budget];
    row.invalidRun = invalid.length > 0;
    row.result =
      row.problems.length === 0
        ? 'pass'
        : invalid.length
          ? 'invalid'
          : enforce
            ? 'fail'
            : 'budget-breach';
    rows.push(row);
    const problems = row.problems;
    const status =
      row.result === 'pass' ? 'pass' : row.result === 'budget-breach' ? 'skip' : 'fail';
    const detail = `${row.result === 'budget-breach' ? 'budget breach recorded as a product defect (first baseline): ' : ''}LH LCP ${row.lighthouse.lcpMs?.toFixed(0)} CLS ${row.lighthouse.cls?.toFixed(3)} TBT ${row.lighthouse.tbtMs?.toFixed(0)}; PW LCP ${row.playwright.lcpMs?.toFixed(0)} CLS ${row.playwright.cls?.toFixed(3)} INP ${row.playwright.inpMs ?? 'not observed'}${problems.length ? ` | ${problems.join('; ')}` : ''}`;
    spawnSync('node', [
      results,
      'add',
      'frontend',
      `TC-NFR-02 ${route.id} ${profile}`,
      status,
      detail,
    ]);
  }
}
const ok = rows.every((r) => r.result === 'pass');
const runValid = rows.every((r) => !r.invalidRun);
const exitOk = enforce ? ok : runValid;
const report = {
  tool: 'Lighthouse CI and Playwright web-vitals',
  lighthouseVersion: lh.toolVersion,
  lighthouseBrowser: lh.browser,
  playwrightBrowser: pw.browser,
  conditions: pw.conditions,
  concurrency: { lighthouse: lh.concurrency, playwright: pw.concurrency },
  target: fe,
  rows,
  mode,
  result: ok ? 'pass' : runValid ? (enforce ? 'fail' : 'budget breaches recorded') : 'invalid run',
  breaches: rows
    .filter((r) => r.result === 'budget-breach' || r.result === 'fail')
    .map((r) => `${r.route} ${r.profile}: ${r.problems.join('; ')}`),
};
writeFileSync(outFile, JSON.stringify(report, null, 2));
for (const r of rows)
  process.stdout.write(
    `${r.result === 'pass' ? 'PASS' : r.result === 'budget-breach' ? 'BREACH' : 'FAIL'} ${r.route} ${r.profile}: ${r.problems.join('; ') || 'within budget'}\n`,
  );
process.stdout.write(`frontend (${mode}): ${report.result}\n`);
process.exit(exitOk ? 0 : 1);
