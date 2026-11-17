import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-074';

test.describe('@TASK-074 table, card, empty and error state (CMP-016, 018, 019) through the built web app', () => {
  test('table: sort button reorders rows; row action works; scroll region is labelled', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const cell = page.locator('[data-cell=table-content]');
    await expect(cell.getByRole('region', { name: 'Campaigns' })).toHaveAttribute('tabindex', '0');
    await cell.getByRole('button', { name: 'Sort by Campaign' }).click();
    await expect(cell.getByRole('columnheader', { name: /Campaign/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await cell.getByRole('button', { name: 'Open' }).first().click();
    await expect(cell.getByTestId('table-last')).not.toHaveText('none');
  });

  test('table states: skeleton, no results, error and pending are reachable', async ({ page }) => {
    await page.goto('/gallery');
    await expect(page.locator('[data-cell=table-loading] [data-skeleton]').first()).toBeAttached();
    await expect(
      page.locator('[data-cell=table-empty]').getByRole('heading', { name: 'No campaigns yet' }),
    ).toBeVisible();
    await expect(page.locator('[data-cell=table-error]').getByRole('alert')).toBeVisible();
    await expect(page.locator('[data-cell=table-pending] [aria-busy=true]').first()).toBeAttached();
    await expect(page.locator('[data-cell=table-selected] [data-selected]')).toHaveCount(1);
  });

  test('card is one link when clickable; empty error retry works', async ({ page }) => {
    await page.goto('/gallery');
    await expect(page.locator('[data-cell=card-link]').getByRole('link')).toHaveCount(1);
    await page
      .locator('[data-cell=empty-error]')
      .getByRole('button', { name: 'Try again' })
      .click();
    await expect(page.getByTestId('retry-count')).toHaveText('retries: 1');
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`gallery matches its baseline and has no axe violations at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const section = page.locator('[data-testid=comp-data]');
      await expectNoAxeViolations(
        page,
        `${evidence}/axe/${info.project.name}-comp-data-${name}.json`,
      );
      await page.evaluate(() => document.fonts.ready);
      await expect(section).toHaveScreenshot(`comp-data-${name}.png`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await section.screenshot({ path: `${evidence}/screenshots/comp-data-${name}.png` });
    });
  }
});
