import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-075';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('@TASK-075 file upload (CMP-021) through the built web app', () => {
  test('picker: an image goes uploading to ready, a PDF is rejected with its reason, remove works', async ({ page }) => {
    await page.goto('/gallery');
    const cell = page.locator('[data-cell=upload-live]');
    await expect(cell.getByRole('button', { name: /Upload an image/ })).toBeVisible();
    await cell.getByTestId('file-upload-input').setInputFiles([
      { name: 'bottle.png', mimeType: 'image/png', buffer: png },
      { name: 'label.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
    ]);
    await expect(cell.locator('li[data-status=rejected]')).toContainText('Not supported');
    await expect(cell.locator('li[data-status=ready]')).toContainText('bottle.png');
    await cell.getByRole('button', { name: 'Remove bottle.png' }).click();
    await expect(cell.locator('li[data-status=ready]')).toHaveCount(0);
  });

  test('zone is reachable and activatable by keyboard', async ({ page }) => {
    await page.goto('/gallery');
    const zone = page.locator('[data-cell=upload-idle]').getByRole('button', { name: /Upload an image/ });
    await zone.focus();
    await expect(zone).toBeFocused();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    expect((await chooser).isMultiple()).toBe(true);
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`gallery matches its baseline and has no axe violations at ${name} px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const section = page.locator('[data-testid=comp-upload]');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-comp-upload-${name}.json`);
      await page.evaluate(() => document.fonts.ready);
      await expect(section).toHaveScreenshot(`comp-upload-${name}.png`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await section.screenshot({ path: `${evidence}/screenshots/comp-upload-${name}.png` });
    });
  }
});
