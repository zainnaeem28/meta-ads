#!/usr/bin/env node
// TASK-116: the personal-data sink scanner (TC-LOG-03). It reads files (logs, reports, evidence) and reports every place
// that holds a canary of this suite, a synthetic address, a bearer token, a JWT or a signed-URL query. Values are never
// copied into the report: only rule, file and line. Output is SARIF 2.1.0 so `submit_check.py --secrets` reads it, and the
// exit code is 1 on any finding. Usage: scan-sinks.mjs [--out report.sarif] PATH...   (a PATH is a file or a folder)
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const RULES = [
  ['sink-canary-key', /canary-OPENAI|wavecanary_/],
  [
    'sink-canary-content',
    /canary-(?:dialogue|description|transcript|prompt|product|500)-?|exif-owner-canary|inferred-(?:ethnicity|health)-canary/,
  ],
  ['sink-synthetic-email', /[A-Za-z0-9._%+-]+@example\.test/],
  ['sink-bearer-token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/],
  ['sink-jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/],
  ['sink-signed-url', /X-Amz-(?:Signature|Credential|Security-Token)=/i],
];
const TEXT = /\.(?:log|ndjson|jsonl|xml|sarif|json|txt|md|csv|lcov|info)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

export function scanText(text) {
  const findings = [];
  text.split('\n').forEach((line, index) => {
    for (const [rule, pattern] of RULES)
      if (pattern.test(line)) findings.push({ rule, line: index + 1 });
  });
  return findings;
}

function* walk(path) {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (TEXT.test(path)) yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    yield* walk(join(path, entry));
  }
}

export function scanPaths(paths, root = process.cwd()) {
  const results = [];
  for (const path of paths) {
    let files;
    try {
      files = [...walk(resolve(path))];
    } catch {
      continue; // a missing path has nothing to scan
    }
    for (const file of files) {
      for (const finding of scanText(readFileSync(file, 'utf8')))
        results.push({ ...finding, file: relative(root, file) });
    }
  }
  return results;
}

export function toSarif(results) {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'shroomap-sink-scan',
            rules: RULES.map(([id]) => ({ id, shortDescription: { text: id } })),
          },
        },
        results: results.map((r) => ({
          ruleId: r.rule,
          level: 'error',
          message: { text: `${r.rule}: personal data or a canary in a sink (value not shown)` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: r.file },
                region: { startLine: r.line },
              },
            },
          ],
        })),
      },
    ],
  };
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  let out;
  const paths = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i];
    else paths.push(args[i]);
  }
  const results = scanPaths(paths);
  if (out !== undefined) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(toSarif(results), null, 2));
  }
  for (const r of results) console.error(`${r.rule} ${r.file}:${String(r.line)}`);
  console.log(`sink scan: ${String(results.length)} finding(s) in ${String(paths.length)} path(s)`);
  process.exit(results.length === 0 ? 0 : 1);
}
