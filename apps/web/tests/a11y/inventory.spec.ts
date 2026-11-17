import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { GROUPS } from './groups';

/**
 * The generated coverage check, run in the same Playwright run as the captures: every screen x state x viewport of the
 * frame manifest has an axe result and an approved baseline, and every screen group this suite drives has its
 * reflow, zoom and text-spacing captures (scripts/ci/screen-coverage.mjs).
 */
const repo = resolve(__dirname, '../../../..');

test('@a11y @TASK-118 inventory: every screen, state and viewport has an axe result and an approved baseline', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium');
  const out = execFileSync(
    'node',
    ['scripts/ci/screen-coverage.mjs', '--out', resolve(__dirname, '../../reports/a11y')],
    { cwd: repo, encoding: 'utf8' },
  );
  expect(out).toMatch(/0 failure\(s\)/);
  const report = JSON.parse(
    readFileSync(resolve(__dirname, '../../reports/a11y/screen-coverage.json'), 'utf8'),
  );
  expect(report.summary.statesCovered).toBe(report.summary.statesXViewports);
  // The groups this suite drives are the groups the generated list demands.
  const map = JSON.parse(readFileSync(resolve(__dirname, 'screen-map.json'), 'utf8'));
  expect(GROUPS.map((g) => g.id).sort()).toEqual(Object.keys(map.groups).sort());
});
