import { expect, type Page } from '@playwright/test';

/** Design widths (UI-UX §4): phone, tablet, desktop. */
export const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 900 },
] as const;

/**
 * The agreed comparison settings, used by playwright.config.ts and every visual test:
 * per-pixel colour tolerance 0.1 and at most 0.1 % of pixels different.
 * Baselines are approved by UI/UX; a later diff needs UI/UX approval before `--update-snapshots`
 * is committed (docs/evidence/TASK-067/README.md, "Baseline approval").
 */
export const SCREENSHOT = {
  threshold: 0.1,
  maxDiffPixelRatio: 0.001,
  animations: 'disabled',
  caret: 'hide',
  scale: 'css',
} as const;

/** Waits for the real fonts, then compares the page (or a locator) with the approved baseline. */
export async function expectScreenshot(
  page: Page,
  name: string,
  options: { fullPage?: boolean } = {},
) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, ...options });
}
