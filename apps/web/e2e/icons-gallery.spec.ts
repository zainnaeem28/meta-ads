import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ICON_NAMES } from '@shroomap/ui/icons';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS, expectScreenshot } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-067';

test.describe('@TASK-067 icons and gallery through the built web app', () => {
  test('gallery renders every design icon at 16, 20 and 24 px and is noindex', async ({ page }) => {
    const response = await page.goto('/gallery');
    expect(response?.status()).toBe(200);
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);

    const cells = page.locator('[data-icon-cell]');
    await expect(cells).toHaveCount(ICON_NAMES.length);
    expect(ICON_NAMES).toHaveLength(72);
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-icon-cell]')].map((cell) =>
        [...cell.querySelectorAll('svg')].map((svg) => [
          svg.getAttribute('width'),
          svg.getAttribute('stroke-width'),
          svg.getAttribute('aria-hidden'),
          getComputedStyle(svg).stroke,
        ]),
      ),
    );
    for (const cell of sizes) {
      expect(cell.map((s) => s[0])).toEqual(['16', '20', '24']);
      for (const [, stroke, hidden, colour] of cell) {
        expect(stroke).toBe('2');
        expect(hidden).toBe('true');
        expect(colour).toBe('rgb(35, 45, 56)');
      }
    }
  });

  test('gallery is not served in a production deployment', async ({ request }) => {
    const res = await request.get(`${process.env.E2E_PROD_URL}/gallery`);
    expect(res.status()).toBe(404);
  });

  for (const { name, width, height } of VIEWPORTS) {
    test(`icon gallery matches its baseline and has no axe violations at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-icons-${name}.json`);
      await expectScreenshot(page, `icons-${name}`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await page.screenshot({ path: `${evidence}/screenshots/icons-${name}.png`, fullPage: true });
    });
  }

  test('runs beside the built api', async ({ request }) => {
    const res = await request.get(`${process.env.E2E_API_URL}/health/live`);
    expect(res.ok()).toBe(true);
  });
});

test.describe('@harness visual and axe harness on a sample page', () => {
  for (const { name, width, height } of VIEWPORTS) {
    test(`home at ${name} px: baseline and axe`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-home-${name}.json`);
      await expectScreenshot(page, `home-${name}`);
    });
  }
});
