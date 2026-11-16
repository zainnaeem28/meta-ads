import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-073';

test.describe('@TASK-073 tabs, stepper, filter bar and pagination (CMP-014, 015, 017) through the built web app', () => {
  test('tabs: arrow keys move selection and skip the disabled tab', async ({ page }) => {
    await page.goto('/gallery');
    const cell = page.locator('[data-cell=tabs-first]');
    await cell.getByRole('tab', { name: 'All 12' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(cell.getByRole('tab', { name: 'In review 3' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(cell.getByRole('tab', { name: 'Done 9' })).toHaveAttribute('aria-selected', 'true');
    await expect(cell.getByRole('tab', { name: 'Locked' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('stepper marks the current step', async ({ page }) => {
    await page.goto('/gallery');
    const list = page.locator('[data-cell=stepper-1]').getByRole('list', { name: 'Progress' });
    await expect(list.locator('[aria-current=step]')).toHaveText(/Business/);
  });

  test('filter bar: chips toggle, query state follows, clear-all and no-matches', async ({ page }) => {
    await page.goto('/gallery');
    const cell = page.locator('[data-cell=filter-default]');
    const chip = cell.getByRole('button', { name: 'Failed 2' });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(cell.getByTestId('list-search')).toHaveText('?status=failed');
    await cell.getByRole('button', { name: 'Clear all' }).click();
    await expect(cell.getByTestId('list-search')).toHaveText('(none)');
    await cell.getByRole('button', { name: 'Next' }).click();
    await expect(cell.getByTestId('list-search')).toHaveText('?page=2');
    await expect(page.locator('[data-cell=filter-nomatches]').getByText('No results match these filters.')).toBeVisible();
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`gallery matches its baseline and has no axe violations at ${name} px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const section = page.locator('[data-testid=comp-nav]');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-comp-nav-${name}.json`);
      await page.evaluate(() => document.fonts.ready);
      await expect(section).toHaveScreenshot(`comp-nav-${name}.png`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await section.screenshot({ path: `${evidence}/screenshots/comp-nav-${name}.png` });
    });
  }
});
