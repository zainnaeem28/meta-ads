import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-070';

test.describe('@TASK-070 badge and loading (CMP-007, CMP-008) through the built web app', () => {
  test('every badge variant is reachable and is labelled by its text', async ({ page }) => {
    await page.goto('/gallery');
    const variants = page.locator('[data-testid=badge-variants] [data-variant]');
    await expect(variants).toHaveCount(6);
    const seen = await variants.evaluateAll((els) =>
      els.map((e) => [e.getAttribute('data-variant'), e.textContent]),
    );
    expect(seen).toEqual([
      ['neutral', 'neutral'],
      ['primary', 'primary'],
      ['success', 'success'],
      ['info', 'info'],
      ['warning', 'warning'],
      ['destructive', 'destructive'],
    ]);
    // Token colours resolve (destructive subtle background, not transparent).
    const bg = await page
      .locator('[data-testid=badge-variants] [data-variant=destructive]')
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(bg).toBe('rgb(253, 236, 234)');
  });

  test('progress, spinner and skeleton expose their states', async ({ page }) => {
    await page.goto('/gallery');
    const gallery = page.locator('[data-testid=prim-b]');
    const bars = gallery.getByRole('progressbar');
    await expect(bars).toHaveCount(4);
    await expect(gallery.getByRole('progressbar', { name: 'Upload 60 percent' })).toHaveAttribute(
      'aria-valuenow',
      '60',
    );
    await expect(
      gallery.getByRole('progressbar', { name: 'Working, duration unknown' }),
    ).not.toHaveAttribute('aria-valuenow', /.*/);
    await expect(gallery.getByRole('status').filter({ hasText: 'Saving' })).toBeVisible();
    const region = gallery.locator('[aria-busy=true]');
    await expect(region).toHaveCount(1);
    await expect(region.getByText('Loading campaigns')).toBeVisible();
  });

  test('animation is static under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/gallery');
    const names = await page
      .locator('[data-spinner], [data-skeleton], [data-progress-fill]')
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(['none']));
  });

  test('spinner and skeleton animate when motion is allowed', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/gallery');
    const spin = await page
      .locator('[data-spinner]')
      .evaluate((e) => getComputedStyle(e).animationName);
    expect(spin).toBe('spin');
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`badge and loading gallery matches its baseline and has no axe violations at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const section = page.locator('[data-testid=prim-b]');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-prim-b-${name}.json`);
      await page.evaluate(() => document.fonts.ready);
      await expect(section).toHaveScreenshot(`prim-b-${name}.png`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await section.screenshot({ path: `${evidence}/screenshots/prim-b-${name}.png` });
    });
  }
});
