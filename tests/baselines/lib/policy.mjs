/* global process */
// Reads the pass conditions of the baselines from config/quality-policy.json (never hard-coded in the scripts).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function baselinePolicy() {
  const path = process.env.CI_POLICY ?? join(root, 'config', 'quality-policy.json');
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  if (!policy.baselines) throw new Error(`${path} has no "baselines" section`);
  return { policy, baselines: policy.baselines };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // CLI for the shell wrappers: policy.mjs get dast.failOnSource -> prints the value (JSON for objects)
  const { policy, baselines } = baselinePolicy();
  const path = process.argv[3] ?? '';
  const base = process.argv[2] === 'policy' ? policy : baselines;
  let value = base;
  for (const key of path.split('.').filter(Boolean)) value = value?.[key];
  if (value === undefined) {
    process.stderr.write(`policy: ${path} is not set\n`);
    process.exit(1);
  }
  process.stdout.write(typeof value === 'object' ? JSON.stringify(value) : String(value));
}
