#!/usr/bin/env node

// The one place the baseline wrappers record test cases. Every case lands in reports/baselines/results.json, and
// reports/baselines/junit.xml (the file `submit_check.py --junit` reads) is rebuilt from all suites after each change.
//
//   results.mjs reset SUITE                        forget the suite's earlier cases
//   results.mjs add SUITE NAME pass|fail|skip [MESSAGE] [SECONDS]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = join(process.env.CI_REPORTS_DIR ?? join(root, 'reports'), 'baselines');
const file = join(dir, 'results.json');
const esc = (text) =>
  String(text).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );

const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});

function write(all) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2));
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  const suites = Object.entries(all).map(([suite, cases]) => {
    const f = cases.filter((c) => c.status === 'fail').length;
    const s = cases.filter((c) => c.status === 'skip').length;
    tests += cases.length;
    failures += f;
    skipped += s;
    const body = cases
      .map((c) => {
        const inner =
          c.status === 'fail'
            ? `<failure message="${esc(c.message ?? 'failed')}"/>`
            : c.status === 'skip'
              ? `<skipped message="${esc(c.message ?? '')}"/>`
              : '';
        return `    <testcase classname="baselines.${esc(suite)}" name="${esc(c.name)}" time="${Number(c.seconds ?? 0).toFixed(3)}">${inner}</testcase>`;
      })
      .join('\n');
    return `  <testsuite name="baselines.${esc(suite)}" tests="${cases.length}" failures="${f}" skipped="${s}" errors="0">\n${body}\n  </testsuite>`;
  });
  writeFileSync(
    join(dir, 'junit.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${tests}" failures="${failures}" skipped="${skipped}" errors="0">\n${suites.join('\n')}\n</testsuites>\n`,
  );
}

const [command, suite, name, status, message, seconds] = process.argv.slice(2);
if (command === 'reset' && suite) {
  const all = read();
  delete all[suite];
  write(all);
} else if (command === 'add' && suite && name && ['pass', 'fail', 'skip'].includes(status)) {
  const all = read();
  (all[suite] ??= []).push({
    name,
    status,
    message: message || undefined,
    seconds: Number(seconds ?? 0),
  });
  write(all);
} else {
  process.stderr.write(
    'usage: results.mjs reset SUITE | add SUITE NAME pass|fail|skip [MESSAGE] [SECONDS]\n',
  );
  process.exit(2);
}
