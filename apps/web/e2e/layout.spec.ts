import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-078';

test.describe('@TASK-078 page header, page grid and auth shell (CMP-033, 034, 032) through the built web app', () => {
  test('page header: one h1, breadcrumb marks the current page, stage tabs skip disabled stages', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const cell = page.locator('[data-cell=header-campaign]');
    await expect(
      cell.getByRole('heading', { level: 1, name: 'Morning Focus Blend' }),
    ).toBeVisible();
    await expect(
      cell.getByRole('navigation', { name: 'Breadcrumb' }).locator('[aria-current=page]'),
    ).toHaveText('Morning Focus Blend');
    await expect(cell.getByRole('tab', { name: 'Clips' })).toHaveAttribute('aria-disabled', 'true');
    await expect(
      page.locator('[data-cell=header-default]').getByRole('button', { name: 'New brief' }),
    ).toBeVisible();
  });

  test('page grid: columns span 12 from 768 px and collapse to one column under it', async ({
    page,
  }) => {
    const cols = () => page.locator('[data-cell=grid] [data-span]');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    const wide = await cols().evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    expect(wide[2]).toBeGreaterThan(wide[0]);
    expect(wide[5]).toBeGreaterThan(wide[4]);
    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await cols().evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().width)),
    );
    expect(new Set(narrow).size).toBe(1);
  });

  test('auth shell: every variant and provider state is reachable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    await expect(
      page.locator('[data-cell=auth-signin]').getByRole('heading', { level: 1 }),
    ).toBeVisible();
    await expect(page.locator('[data-cell=auth-signin] [data-brand-panel]')).toBeAttached();
    await expect(page.locator('[data-cell=auth-loading] [aria-busy=true]')).toBeAttached();
    await expect(page.locator('[data-cell=auth-error]').getByRole('alert')).toBeVisible();
    await expect(
      page.locator('[data-cell=auth-message]').getByRole('link', { name: 'Go Home' }),
    ).toBeVisible();
    await expect(
      page.locator('[data-cell=auth-mfa]').getByRole('heading', { name: 'Two-step verification' }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-cell=auth-signin] [data-brand-panel]')).toBeHidden();
    await expect(page.locator('[data-cell=auth-signin] [data-mobile-lockup]')).toBeVisible();
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`gallery matches its baseline and has no axe violations at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const section = page.locator('[data-testid=layout]');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-layout-${name}.json`);
      await page.evaluate(() => document.fonts.ready);
      await expect(section).toHaveScreenshot(`layout-${name}.png`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await section.screenshot({ path: `${evidence}/screenshots/layout-${name}.png` });
    });
  }
});
