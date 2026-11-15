import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-069';
const cell = (page: Page, id: string) => page.locator(`[data-cell="${id}"]`);
const slug = (id: string) => id.replaceAll('/', '-');

const BUTTONS = ['primary', 'secondary', 'outline', 'ghost', 'destructive', 'destructive-outline'];
const GROUPS = ['CMP-003', 'CMP-004', 'CMP-005', 'CMP-006'];

async function snap(target: Locator, name: string, vp: string) {
  await target.page().evaluate(() => document.fonts.ready);
  mkdirSync(`${evidence}/screenshots`, { recursive: true });
  await target.screenshot({ path: `${evidence}/screenshots/${name}-${vp}.png` });
  await expect(target).toHaveScreenshot(`prim-a-${name}-${vp}.png`);
}

test.describe('@TASK-069 primitives A through the built web app', () => {
  test('gallery lists every variant and state of CMP-003 to CMP-006', async ({ page }) => {
    await page.goto('/gallery');
    const ids = await page
      .locator('[data-cell]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-cell')!));
    for (const v of BUTTONS) {
      for (const s of ['default', 'disabled', 'pending'])
        expect(ids).toContain(`CMP-003/${v}/${s}`);
    }
    for (const id of [
      'CMP-003/icon-only/default',
      'CMP-003/icon-only/disabled',
      'CMP-003/icon-only/pending',
      'CMP-003/small/default',
    ]) {
      expect(ids).toContain(id);
    }
    for (const k of ['text', 'textarea']) {
      for (const s of ['empty', 'filled', 'invalid', 'disabled', 'read-only'])
        expect(ids).toContain(`CMP-004/${k}/${s}`);
    }
    for (const s of ['empty', 'filled', 'invalid', 'disabled']) {
      expect(ids).toContain(`CMP-004/key/${s}`);
      expect(ids).toContain(`CMP-005/single/${s}`);
    }
    for (const id of [
      'radio-card/default',
      'radio-card/checked',
      'radio-card/disabled',
      'checkbox/default',
      'checkbox/checked',
      'checkbox/disabled',
      'checkbox/unavailable',
      'segmented/default',
      'switch/default',
      'switch/checked',
      'switch/disabled',
      'switch/unavailable',
    ])
      expect(ids).toContain(`CMP-006/${id}`);
    await expect(page.getByText('Not in this release', { exact: true })).toHaveCount(3);
  });

  test('masked key input never reveals and is not autofilled', async ({ page }) => {
    await page.goto('/gallery');
    const input = cell(page, 'CMP-004/key/filled').locator('input');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveAttribute('autocomplete', 'off');
    await expect(cell(page, 'CMP-004/key/filled').getByRole('button')).toHaveCount(0);
  });

  test('keyboard: switch, checkbox, segmented and radio card, textarea counter', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const sw = cell(page, 'CMP-006/switch/default').getByRole('switch');
    await sw.focus();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Enter');
    await expect(sw).toHaveAttribute('aria-checked', 'false');

    const box = cell(page, 'CMP-006/checkbox/default').getByRole('checkbox');
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).toBeChecked();

    const first = cell(page, 'CMP-006/segmented/default').getByRole('radio', { name: '9:16' });
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(
      cell(page, 'CMP-006/segmented/default').getByRole('radio', { name: '1:1' }),
    ).toBeChecked();
    // The disabled 16:9 option is skipped, so the next step wraps to the first option.
    await page.keyboard.press('ArrowRight');
    await expect(first).toBeChecked();

    await expect(cell(page, 'CMP-006/radio-card/disabled').getByRole('radio')).toBeDisabled();

    const area = cell(page, 'CMP-004/textarea/empty').getByRole('textbox');
    await area.fill('hello');
    await expect(page.locator('#g-ta-empty-counter')).toHaveText('5 / 500');

    const button = cell(page, 'CMP-003/primary/default').getByRole('button');
    await button.focus();
    await expect(button).toBeFocused();
  });

  test('pending button keeps its width and announces busy', async ({ page }) => {
    await page.goto('/gallery');
    const idle = await cell(page, 'CMP-003/primary/default').getByRole('button').boundingBox();
    const pending = cell(page, 'CMP-003/primary/pending').getByRole('button');
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await expect(pending).toHaveAccessibleName('Saving…');
    const busy = await pending.boundingBox();
    expect(Math.round(busy!.width)).toBe(Math.round(idle!.width));
  });

  test('runs beside the built api', async ({ request }) => {
    const res = await request.get(`${process.env.E2E_API_URL}/health/live`);
    expect(res.ok()).toBe(true);
  });

  for (const { name, width, height } of VIEWPORTS) {
    test.describe(`at ${name} px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.goto('/gallery');
        await page.evaluate(() => document.fonts.ready);
      });

      test('axe: no violations on the gallery section', async ({ page }, info) => {
        await expectNoAxeViolations(
          page,
          `${evidence}/axe/${info.project.name}-prim-a-${name}.json`,
          '[data-testid="prim-a"]',
        );
      });

      test('touch targets: 44 px on a phone, 40 px otherwise', async ({ page }) => {
        const phone = width < 768;
        const h = async (loc: Locator) => Math.round((await loc.boundingBox())!.height);
        expect(await h(cell(page, 'CMP-003/primary/default').getByRole('button'))).toBe(
          phone ? 44 : 40,
        );
        expect(await h(cell(page, 'CMP-003/small/default').getByRole('button'))).toBe(
          phone ? 44 : 32,
        );
        expect(await h(cell(page, 'CMP-004/text/empty').getByRole('textbox'))).toBe(
          phone ? 44 : 40,
        );
        expect(await h(cell(page, 'CMP-005/single/empty').getByRole('combobox'))).toBe(
          phone ? 44 : 40,
        );
        expect(
          await h(cell(page, 'CMP-006/checkbox/default').locator('label')),
        ).toBeGreaterThanOrEqual(44);
        expect(
          await h(cell(page, 'CMP-006/switch/default').getByRole('switch')),
        ).toBeGreaterThanOrEqual(44);
        expect(
          await h(
            cell(page, 'CMP-006/segmented/default')
              .getByRole('radio', { name: '9:16' })
              .locator('xpath=..'),
          ),
        ).toBeGreaterThanOrEqual(44);
      });

      if (name !== '768') {
        for (const group of GROUPS) {
          test(`${group}: baseline of every variant and state`, async ({ page }) => {
            await snap(page.locator(`section[aria-labelledby="${group}-h"]`), group, name);
          });
        }

        for (const v of BUTTONS) {
          test(`CMP-003 ${v}: hover, focus and active baselines`, async ({ page }) => {
            const c = cell(page, `CMP-003/${v}/default`);
            const button = c.getByRole('button');
            await button.hover();
            await snap(c, `CMP-003-${v}-hover`, name);
            await page.mouse.down();
            await snap(c, `CMP-003-${v}-active`, name);
            await page.mouse.up();
            await page.mouse.move(0, 0);
            await page.keyboard.press('Shift');
            await button.focus();
            await expect(button).toHaveCSS('outline-style', 'solid');
            await snap(c, `CMP-003-${v}-focus`, name);
          });
        }

        for (const [id, role] of [
          ['CMP-004/text/empty', 'textbox'],
          ['CMP-004/textarea/empty', 'textbox'],
          ['CMP-004/key/empty', 'textbox'],
          ['CMP-005/single/empty', 'combobox'],
        ] as const) {
          test(`${id}: hover and focus baselines`, async ({ page }) => {
            const c = cell(page, id);
            const control = c.getByRole(role);
            await control.hover();
            await snap(c, `${slug(id)}-hover`, name);
            await page.mouse.move(0, 0);
            await page.keyboard.press('Shift');
            await control.focus();
            await expect(control).toHaveCSS('outline-style', 'solid');
            await snap(c, `${slug(id)}-focus`, name);
          });
        }

        for (const [id, role] of [
          ['CMP-006/radio-card/default', 'radio'],
          ['CMP-006/checkbox/default', 'checkbox'],
          ['CMP-006/segmented/default', 'radio'],
          ['CMP-006/switch/default', 'switch'],
        ] as const) {
          test(`${id}: hover and focus baselines`, async ({ page }) => {
            const c = cell(page, id);
            const control = c.getByRole(role).first();
            await c.locator('label, button').first().hover();
            await snap(c, `${slug(id)}-hover`, name);
            await page.mouse.move(0, 0);
            await page.keyboard.press('Shift');
            await control.focus();
            await snap(c, `${slug(id)}-focus`, name);
          });
        }
      }
    });
  }
});
