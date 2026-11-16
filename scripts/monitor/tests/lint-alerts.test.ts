import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintAlerts } from '../src/lint-alerts.ts';
import type { AlertDoc } from '../src/lint-alerts.ts';

// Alert rules as data: a lint fails on a missing required field.

const root = join(import.meta.dirname, '..', '..', '..');
const doc = (): AlertDoc =>
  JSON.parse(readFileSync(join(root, 'infra', 'monitoring', 'alerts.json'), 'utf8')) as AlertDoc;
const runbooks = join(root, 'docs', 'ops', 'runbooks');

describe('infra/monitoring/alerts.json', () => {
  it('has ALR-1 to ALR-10, each with the six required fields and an existing runbook', () => {
    const d = doc();
    expect(d.alerts.map((a) => a['id'])).toEqual(
      Array.from({ length: 10 }, (_, i) => `ALR-${i + 1}`),
    );
    expect(d.requiredFields).toEqual([
      'rule',
      'owner',
      'runbook',
      'volumeCondition',
      'recoveryCondition',
      'missingDataSignal',
    ]);
    expect(lintAlerts(d, runbooks)).toEqual([]);
  });

  it('fails on each missing or empty required field', () => {
    for (const field of doc().requiredFields) {
      const d = doc();
      delete d.alerts[3]?.[field];
      expect(lintAlerts(d, runbooks).join('\n')).toContain(`ALR-4: missing or empty "${field}"`);
      const e = doc();
      (e.alerts[4] as Record<string, unknown>)[field] = '  ';
      expect(lintAlerts(e, runbooks).join('\n')).toContain(`ALR-5: missing or empty "${field}"`);
    }
  });

  it('fails on an unknown runbook, a duplicate id, a monitor alert without params, and an empty file', () => {
    const d = doc();
    (d.alerts[0] as Record<string, unknown>)['runbook'] = 'RB-nope';
    (d.alerts[2] as Record<string, unknown>)['id'] = 'ALR-1';
    delete d.alerts[1]?.['params'];
    const text = lintAlerts(d, runbooks).join('\n');
    expect(text).toContain('RB-nope.md does not exist');
    expect(text).toContain('duplicate id');
    expect(text).toContain('ALR-2: a monitor alert needs "params"');
    expect(lintAlerts({ requiredFields: [], alerts: [] }, null)).toEqual(['no alerts']);
  });

  it('every runbook names its alert and has no unfilled marker', () => {
    for (const alert of doc().alerts) {
      const text = readFileSync(join(runbooks, `${alert['runbook'] as string}.md`), 'utf8');
      expect(text).toContain(alert['id'] as string);
      expect(text).not.toMatch(/\bTODO\b|\bTBD\b|<[A-Z ]+>/);
    }
  });
});
