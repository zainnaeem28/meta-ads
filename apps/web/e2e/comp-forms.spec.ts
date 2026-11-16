import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-071';

test.describe('@TASK-071 form field, alert, toast (CMP-010, 011, 012) through the built web app', () => {
  test('submit failure focuses the summary, maps field errors and shows first 5 then more', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const demo = page.locator('[data-testid=form-demo]');
    await demo.getByRole('button', { name: 'Submit' }).click();
    const summary = demo.getByRole('group');
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('listitem')).toHaveCount(5);
    await expect(demo.getByLabel(/Campaign name/)).toHaveAccessibleDescription(
      'Shown in your campaign list. Enter a campaign name.',
    );
    await summary.getByRole('link', { name: 'Segment 2 dialogue' }).click();
    await expect(demo.getByLabel(/Segment 2 dialogue/)).toBeFocused();
    const more = summary.getByRole('button', { name: 'and 3 more' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(summary.getByRole('listitem').nth(5)).toBeFocused();
    await expect(summary.getByRole('listitem')).toHaveCount(8);
  });

  test('every alert variant is reachable with the right live role', async ({ page }) => {
    await page.goto('/gallery');
    const alerts = page.locator('[data-testid=alerts] [data-variant]');
    expect(
      await alerts.evaluateAll((els) =>
        els.map((e) => [e.getAttribute('data-variant'), e.getAttribute('role')]),
      ),
    ).toEqual([
      ['info', 'status'],
      ['success', 'status'],
      ['warning', 'status'],
      ['destructive', 'alert'],
    ]);
  });

  test('toast states are reachable; error toasts stay, live toasts close by name', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const staticToasts = page.locator('[data-testid=toast-static] [data-variant]');
    await expect(staticToasts).toHaveCount(4);
    await expect(page.locator('[data-state=appearing]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Show error toast' }).click();
    const live = page.getByRole('alert').filter({ hasText: 'Live error toast.' });
    await expect(live).toBeVisible();
    await live.getByRole('button', { name: 'Close notification' }).click();
    await expect(live).toHaveCount(0);
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`gallery matches its baseline and has no axe violations at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const section = page.locator('[data-testid=comp-forms]');
      await section.getByRole('button', { name: 'Submit' }).click();
      await expectNoAxeViolations(
        page,
        `${evidence}/axe/${info.project.name}-comp-forms-${name}.json`,
      );
      await page.evaluate(() => document.fonts.ready);
      await expect(section).toHaveScreenshot(`comp-forms-${name}.png`);
      await expect(page.locator('[data-testid=toast-appearing]')).toHaveScreenshot(
        `comp-forms-toast-appearing-${name}.png`,
      );
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await section.screenshot({ path: `${evidence}/screenshots/comp-forms-${name}.png` });
    });
  }
});
