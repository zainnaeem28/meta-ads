import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.2 AA rule tags the gallery and screens are checked against (UI-UX §12). */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Runs axe on the page, writes the violations to `reportPath` when given and fails on any. */
export async function expectNoAxeViolations(page: Page, reportPath?: string, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(violations, null, 2));
  }
  expect(violations, 'axe violations').toEqual([]);
}
