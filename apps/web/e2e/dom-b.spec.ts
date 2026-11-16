import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-077';

const CELLS = [
  'key-openai-active',
  'key-wavespeed-untested',
  'key-openai-disabled',
  'key-wavespeed-none',
  'key-openai-testing',
  'key-wavespeed-confirm',
  'preview-assembling',
  'preview-done',
  'preview-failed',
  'preview-out-of-date',
];

test.describe('@TASK-077 provider key card, final preview, campaign row, metric tile (CMP-025 to 028) through the built web app', () => {
  test('key card: delete flow moves focus, names actions per provider and has no reveal control', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const cell = page.locator('[data-cell=key-openai-active]');
    await expect(cell.getByRole('button', { name: /show|reveal/i })).toHaveCount(0);
    await cell.getByRole('button', { name: 'Delete OpenAI key' }).click();
    await expect(cell.getByRole('button', { name: 'Keep OpenAI key' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(cell.getByRole('button', { name: 'Add OpenAI key' })).toBeVisible();
  });

  test('final preview: every state is reachable and download asks for a fresh link each click', async ({
    page,
  }) => {
    await page.goto('/gallery');
    for (const state of ['assembling', 'done', 'failed', 'out-of-date']) {
      await expect(page.locator(`[data-cell=preview-${state}] [data-state=${state}]`)).toBeVisible();
    }
    const done = page.locator('[data-cell=preview-done]');
    await expect(done.locator('video')).toHaveAttribute('controls', '');
    await expect(done.locator('video')).toHaveAccessibleName('Summer sale, 9:16, 0:24');
    await done.getByRole('button', { name: 'Download video' }).click();
    await expect(page.getByTestId('downloads-done')).toHaveText('Fresh links requested: 1');
    await done.getByRole('button', { name: 'Download video' }).click();
    await expect(page.getByTestId('downloads-done')).toHaveText('Fresh links requested: 2');
    const box = await done.locator('video').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(320);
  });

  test('campaign row: the name is the one link and deleting turns the actions off', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const rows = page.getByTestId('campaign-rows').getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.first().getByRole('link')).toHaveCount(1);
    await expect(rows.first().getByRole('button')).toHaveCount(2);
    await expect(rows.nth(2)).toHaveAttribute('data-state', 'deleting');
    await expect(rows.nth(2).getByRole('button')).toHaveCount(0);
    await rows.first().getByRole('link').focus();
    await page.keyboard.press('Tab');
    await expect(rows.first().getByRole('button', { name: 'Open Summer sale' })).toBeFocused();
  });

  test('metric tiles: loading, value and no data, with estimated cost and numeric bar labels', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const tiles = page.getByTestId('metric-tiles').getByRole('group');
    await expect(tiles).toHaveCount(4);
    await expect(page.getByRole('group', { name: 'Cost (estimated)' })).toContainText('$12.40');
    await expect(tiles.nth(2)).toHaveAttribute('data-state', 'loading');
    await expect(tiles.nth(3)).toHaveAttribute('data-state', 'no-data');
    await expect(page.getByRole('meter', { name: 'Budget used' })).toHaveAttribute(
      'aria-valuetext',
      '30 of 40',
    );
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`gallery matches its baselines and has no axe violations at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const section = page.getByTestId('dom-b');
      await expectNoAxeViolations(
        page,
        `${evidence}/axe/${info.project.name}-dom-b-${name}.json`,
        '[data-testid=dom-b]',
      );
      await page.evaluate(() => document.fonts.ready);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      for (const id of CELLS) {
        const cell = page.locator(`[data-cell=${id}]`);
        await expect(cell).toHaveScreenshot(`dom-b-${id}-${name}.png`);
        await cell.screenshot({ path: `${evidence}/screenshots/dom-b-${id}-${name}.png` });
      }
      for (const id of ['campaign-rows', 'metric-tiles', 'inline-bar']) {
        const part = page.getByTestId(id);
        await expect(part).toHaveScreenshot(`dom-b-${id}-${name}.png`);
        await part.screenshot({ path: `${evidence}/screenshots/dom-b-${id}-${name}.png` });
      }
      await section.screenshot({ path: `${evidence}/screenshots/dom-b-${name}.png` });
    });
  }
});
