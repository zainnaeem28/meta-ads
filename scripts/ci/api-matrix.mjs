#!/usr/bin/env node
// TASK-065: the gate of the API test matrix. Reads the junit report of `pnpm --filter @shroomap/api test:conformance` and the
// ledger of replies the suite saw, and fails when
//   - an operation x documented status of packages/contracts/openapi.yaml has no passing test (a cell the matrix generated is
//     named "API-nnn sss" in the report),
//   - a test of the run failed,
//   - a registry code was never answered by the running app with the status the registry gives it,
//   - a waived cell (the product cannot answer it) names a finding that is not in docs/evidence/TASK-065/findings.md.
// Usage: node scripts/ci/api-matrix.mjs [--junit <file>] [--ledger <file>] [--findings <file>] [--out <file>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : resolve(argv[at + 1]);
};
const junitFile = option('junit', join(root, 'apps/api/reports/conformance/junit.xml'));
const ledgerFile = option('ledger', join(root, 'apps/api/reports/conformance/observed.jsonl'));
const findingsFile = option('findings', join(root, 'docs/evidence/TASK-065/findings.md'));
const outFile = option('out', join(root, 'apps/api/reports/conformance/api-matrix.json'));

const failures = [];
const need = (file, what) => {
  if (!existsSync(file)) {
    console.error(`api-matrix: ${what} not found: ${file}`);
    process.exit(2);
  }
  return readFileSync(file, 'utf8');
};

// The contract: operations, documented statuses, the registry.
const requireFromContracts = createRequire(join(root, 'packages/contracts/package.json'));
const yaml = requireFromContracts('js-yaml');
const spec = yaml.load(need(join(root, 'packages/contracts/openapi.yaml'), 'the OpenAPI file'));
const cells = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = item[method];
    if (op === undefined) continue;
    for (const status of Object.keys(op.responses)) cells.push({ id: op['x-api-id'], method: method.toUpperCase(), path, status: Number(status) });
  }
}
const registry = spec.components.schemas.ErrorCode.enum;
const statusTable = {};
for (const [, code, status] of need(join(root, 'apps/api/src/platform/http/domain-error.ts'), 'the error table').matchAll(/^\s+([a-z_]+): (\d{3}),$/gm)) statusTable[code] = Number(status);

// The report: one testcase per cell, named "API-nnn sss" (with " [waived FINDING]" when the product cannot answer it).
const junit = need(junitFile, 'the junit report');
const results = new Map();
const waived = new Map();
for (const match of junit.matchAll(/<testcase\s+([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const attributes = match[1];
  const name = /(?:^|\s)name="([^"]*)"/.exec(attributes)?.[1] ?? '';
  const failed = match[3] !== undefined && /<(failure|error)\b/.test(match[3]);
  const skipped = match[3] !== undefined && /<skipped\b/.test(match[3]);
  const cell = /(?:^|>\s)(API-\d{3} \d{3})(?: \[waived ([A-Z0-9-]+)\])?$/.exec(name.replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  if (failed) failures.push(`test failed: ${name}`);
  if (cell === null) continue;
  results.set(cell[1], (results.get(cell[1]) ?? true) && !failed && !skipped);
  if (cell[2] !== undefined) waived.set(cell[1], cell[2]);
}

for (const cell of cells) {
  const key = `${cell.id} ${String(cell.status)}`;
  if (!results.has(key)) failures.push(`no test for ${key} (${cell.method} ${cell.path})`);
  else if (results.get(key) !== true) failures.push(`${key} does not pass`);
}
const known = new Set(cells.map((cell) => `${cell.id} ${String(cell.status)}`));
for (const key of results.keys()) if (!known.has(key)) failures.push(`${key} is tested but the file does not declare it`);

// The ledger: every registry code answered, with the registry's own status.
const ledger = need(ledgerFile, 'the ledger of observed replies').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const answered = new Map();
for (const entry of ledger) if (entry.code !== undefined) answered.set(entry.code, new Set([...(answered.get(entry.code) ?? []), entry.status]));
for (const code of registry) {
  if (statusTable[code] === undefined) failures.push(`registry code ${code} has no status in apps/api/src/platform/http/domain-error.ts`);
  else if (!answered.get(code)?.has(statusTable[code])) failures.push(`registry code ${code} (${String(statusTable[code])}) was never answered by the running app`);
}
for (const [code, statuses] of answered) {
  if (!registry.includes(code)) failures.push(`the app answered ${code}, which is not in the registry`);
  else for (const status of statuses) if (status !== statusTable[code]) failures.push(`code ${code} was answered with ${String(status)}, the registry says ${String(statusTable[code])}`);
}

// The waivers: each names a finding that is written down.
const findings = existsSync(findingsFile) ? readFileSync(findingsFile, 'utf8') : '';
for (const [key, finding] of waived) if (!findings.includes(finding)) failures.push(`${key} is waived for ${finding}, which is not in ${findingsFile}`);

const report = {
  operations: new Set(cells.map((cell) => cell.id)).size,
  cells: cells.length,
  passing: cells.filter((cell) => results.get(`${cell.id} ${String(cell.status)}`) === true).length,
  waived: Object.fromEntries(waived),
  registryCodes: registry.length,
  registryCodesAnswered: registry.filter((code) => answered.get(code)?.has(statusTable[code])).length,
  failures,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(`api-matrix: ${String(report.operations)} operations, ${String(report.passing)}/${String(report.cells)} cells pass (${String(waived.size)} waived with a finding), ${String(report.registryCodesAnswered)}/${String(report.registryCodes)} registry codes answered by the running app`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`api-matrix: FAIL ${failure}`);
  process.exit(1);
}
