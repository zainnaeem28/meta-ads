import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { EVIDENCE, JOURNEYS, RAN, UNAVAILABLE, ensureDir, unavailable } from './support';

/**
 * Zero-test rule: a project that is configured but ran fewer than one passing test per journey fails the run
 * (a project missing from the run, or one whose browser did not start, must never pass silently). Then drops the database.
 */
export default function teardown(config: FullConfig) {
  try {
    // MATRIX_PARTIAL=1 is for a developer's run of some projects; the check that is submitted runs all of them.
    const missing: string[] = [];
    if (process.env.MATRIX_PARTIAL === '1') return;
    const skipped = unavailable();
    ensureDir(EVIDENCE);
    writeFileSync(`${EVIDENCE}/not-executed.json`, `${JSON.stringify(skipped, null, 2)}\n`);
    for (const project of config.projects) {
      if (project.name in skipped) continue; // reported as NOT EXECUTED, never as passed
      const file = `${RAN}/${project.name}.jsonl`;
      const ran = existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { journey: string; ok: boolean })
        : [];
      const passed = new Set(ran.filter((r) => r.ok).map((r) => r.journey));
      for (const j of JOURNEYS)
        if (!passed.has(j.flow)) missing.push(`${project.name}: ${j.flow} did not pass`);
    }
    if (Object.keys(skipped).length === config.projects.length)
      missing.push('no project could launch its browser: nothing was executed');
    if (missing.length) throw new Error(`Browser matrix incomplete:\n${missing.join('\n')}`);
    rmSync(RAN, { recursive: true, force: true });
    rmSync(UNAVAILABLE, { force: true });
  } finally {
    const url = process.env.MATRIX_DATABASE_URL;
    if (url)
      execFileSync('node', [
        resolve(__dirname, '../e2e/flow-11/database.mjs'),
        'drop',
        new URL(url).pathname.slice(1),
      ]);
  }
}
