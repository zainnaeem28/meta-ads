import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Alert rules as data: every alert has the six required fields (rule, owner, runbook, volume condition, recovery
// condition, missing-data signal), a runbook file under docs/ops/runbooks/, and a monitor alert has its parameters.
// Exit 1 on the first run that finds any problem; every problem is listed.

export interface AlertDoc {
  requiredFields: string[];
  alerts: Record<string, unknown>[];
}

export function lintAlerts(doc: AlertDoc, runbookDir: string | null): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(doc.alerts) || doc.alerts.length === 0) return ['no alerts'];
  for (const alert of doc.alerts) {
    const id = typeof alert['id'] === 'string' ? alert['id'] : '(no id)';
    if (ids.has(id)) problems.push(`${id}: duplicate id`);
    ids.add(id);
    for (const field of doc.requiredFields) {
      const value = alert[field];
      if (typeof value !== 'string' || value.trim() === '')
        problems.push(`${id}: missing or empty "${field}"`);
    }
    if (
      alert['evaluator'] === 'monitor' &&
      (typeof alert['params'] !== 'object' || alert['params'] === null)
    ) {
      problems.push(`${id}: a monitor alert needs "params"`);
    }
    const runbook = alert['runbook'];
    if (
      runbookDir !== null &&
      typeof runbook === 'string' &&
      runbook !== '' &&
      !existsSync(join(runbookDir, `${runbook}.md`))
    ) {
      problems.push(`${id}: runbook ${runbook}.md does not exist`);
    }
  }
  return problems;
}

/* v8 ignore start */
if (import.meta.main) {
  const root = join(import.meta.dirname, '..', '..', '..');
  const path = process.argv[2] ?? join(root, 'infra', 'monitoring', 'alerts.json');
  const problems = lintAlerts(
    JSON.parse(readFileSync(path, 'utf8')) as AlertDoc,
    join(root, 'docs', 'ops', 'runbooks'),
  );
  for (const problem of problems) process.stderr.write(`alerts lint: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write('alerts lint: every alert has its six fields and a runbook\n');
}
/* v8 ignore stop */
