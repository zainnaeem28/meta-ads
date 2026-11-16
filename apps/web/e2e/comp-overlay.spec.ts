import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

async function openGallery(page: Page) {
  await page.goto('/gallery');
  await page.waitForLoadState('networkidle'); // hydrated: handlers are attached
}

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-072';

test.describe('@TASK-072 dialog and menu (CMP-013, CMP-020) through the built web app', () => {
  test('dialog: opens modal, traps focus, Escape closes and returns focus', async ({ page }) => {
    await openGallery(page);
    const opener = page.getByRole('button', { name: 'Open confirm' });
    await opener.click();
    const dialog = page.getByTestId('dialog-overlay').getByRole('dialog', { name: 'Pause campaign?' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('typed confirm enables confirm only on the exact name; dirty form asks to discard', async ({ page }) => {
    await openGallery(page);
    await page.getByRole('button', { name: 'Open typed confirm' }).click();
    const dialog = page.getByTestId('dialog-overlay').getByRole('dialog', { name: 'Delete campaign' });
    const confirm = dialog.getByRole('button', { name: 'Delete campaign' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/Type/).fill('Spring launch');
    await confirm.click();
    await expect(page.getByTestId('dialog-result')).toHaveText('Last confirmed: typed-confirm');

    await page.getByRole('button', { name: 'Open form dialog' }).click();
    const form = page.getByTestId('dialog-overlay').getByRole('dialog', { name: 'Rename campaign' });
    await form.getByLabel('Campaign name').fill('Renamed');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-overlay').getByRole('dialog', { name: 'Discard changes?' })).toBeVisible();
    await page.getByTestId('dialog-overlay').getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByTestId('dialog-overlay')).toHaveCount(0);
  });

  test('menu: opens with ArrowDown, skips disabled item, Escape returns focus', async ({ page }) => {
    await openGallery(page);
    const cell = page.locator('[data-cell=menu-closed]');
    const trigger = cell.getByRole('button', { name: 'Actions for Autumn promo' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(cell.getByRole('menuitem', { name: 'Edit' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(cell.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
    await expect(cell.getByRole('menuitem', { name: 'Archive' })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(cell.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('phone menu spans the viewport less 12 px each side although its cell is narrower', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGallery(page);
    const menu = page.locator('[data-cell=menu-row]').getByRole('menu');
    const box = await menu.boundingBox();
    expect(box?.x).toBeCloseTo(12, 0);
    expect(box?.width).toBeCloseTo(366, 0);
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`gallery matches its baseline and has no axe violations at ${name} px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await openGallery(page);
      const section = page.locator('[data-testid=comp-overlay]');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-comp-overlay-${name}.json`);
      await page.evaluate(() => document.fonts.ready);
      await expect(section).toHaveScreenshot(`comp-overlay-${name}.png`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await section.screenshot({ path: `${evidence}/screenshots/comp-overlay-${name}.png` });
    });
  }
});
