import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const mockups = resolve(__dirname, '..');
const manifest: { frame: string; file: string; sha256: string }[] = JSON.parse(
  readFileSync(resolve(mockups, 'png/manifest.json'), 'utf8'),
);
const axeReport: { frame: string; violations: unknown[] }[] = JSON.parse(
  readFileSync(resolve(mockups, 'png/axe-report.json'), 'utf8'),
);

const added = [
  'SCREEN-009--qc-confirm-required',
  'SCREEN-009--cap-reached',
  'SCREEN-006--details-summary',
  'CMP-SHEET-05--default',
].flatMap((name) => [`${name}--1440`, `${name}--390`]);

test.describe('@TASK-086 frames addendum beside the built web app and api', () => {
  test('the built app and api are up', async ({ page, request }) => {
    expect((await page.goto('/'))?.ok()).toBe(true);
    expect((await request.get(`${process.env.E2E_API_URL}/health/live`)).ok()).toBe(true);
  });

  test('the eight new frame/width pairs are in the manifest with matching hashes', () => {
    expect(added).toHaveLength(8);
    for (const name of added) {
      const entry = manifest.find((m) => m.frame === name);
      expect(entry, name).toBeDefined();
      const hash = createHash('sha256').update(readFileSync(resolve(mockups, entry!.file))).digest('hex');
      expect(hash, name).toBe(entry!.sha256);
    }
  });

  test('axe reports zero violations on the new frames', () => {
    for (const name of added) {
      const entry = axeReport.find((a) => a.frame === name);
      expect(entry, name).toBeDefined();
      expect(entry!.violations, name).toEqual([]);
    }
  });
});
