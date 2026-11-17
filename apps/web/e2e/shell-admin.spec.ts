import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-080';
const cell = (id: string) => `[data-cell=${id}]`;

test.describe('@TASK-080 admin shell (CMP-031) through the built web app', () => {
  test('sidebar: portal tag, top rule, five items in order, Back to workspace in the foot', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    const c = page.locator(cell('admin-nav-states'));
    await expect(c.locator('[data-portal=admin]')).toBeVisible();
    await expect(c.locator('[data-portal-tag]')).toHaveText('Administration');
    const rule = await c.locator('header').evaluate((e) => {
      const s = getComputedStyle(e);
      return [s.borderTopWidth, s.borderTopColor];
    });
    expect(rule[0]).toBe('3px');
    const links = c.getByRole('navigation', { name: 'Main' }).getByRole('link');
    await expect(links).toHaveText([
      'Accounts',
      'Invitations',
      'Usage report',
      'Alerts33 unacknowledged',
      'Settings',
      'Back to workspace',
    ]);
    await expect(links.nth(2)).toHaveAttribute('aria-current', 'page');
    const width = await c
      .getByRole('navigation', { name: 'Main' })
      .evaluate((e) => e.getBoundingClientRect().width);
    expect(Math.round(width)).toBe(240);
    const foot = await links.last().evaluate((e) => e.getBoundingClientRect().bottom);
    const nav = await c
      .getByRole('navigation', { name: 'Main' })
      .evaluate((e) => e.getBoundingClientRect().bottom);
    expect(nav - foot).toBeLessThan(16);
  });

  test('alert badge: count on the sidebar, dot on the rail, none at zero, capped at 99+', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    await expect(page.locator(`${cell('admin-sidebar')} [data-alert-count]`)).toContainText('3');
    await expect(page.locator(`${cell('admin-no-alerts')} [data-alert-count]`)).toHaveCount(0);
    await expect(page.locator(`${cell('admin-many-alerts')} [data-alert-count]`)).toContainText(
      '99+',
    );
    const dot = page.locator(`${cell('admin-rail')} [data-alert-count]`);
    const box = await dot.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(8);
    await expect(dot.getByText('3 unacknowledged')).toBeAttached();
  });

  test('keyboard: Tab order follows the nav and the focus ring shows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    await page.waitForLoadState('networkidle');
    const c = page.locator(cell('admin-sidebar'));
    await c.getByRole('link', { name: 'Accounts' }).focus();
    await page.keyboard.press('Tab');
    await expect(c.getByRole('link', { name: 'Invitations' })).toBeFocused();
    expect(
      await c
        .getByRole('link', { name: 'Invitations' })
        .evaluate((e) => getComputedStyle(e).outlineStyle),
    ).not.toBe('none');
    expect(
      await page
        .locator(cell('admin-nav-focus'))
        .getByRole('link', { name: 'Invitations' })
        .evaluate((e) => getComputedStyle(e).outlineWidth),
    ).toBe('2px');
  });

  test('avatar menu offers Switch to workspace; unavailable state has no navigation; disabled item is not a link', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    await expect(page.locator(cell('admin-menu')).getByRole('menuitem')).toHaveText([
      'Switch to workspace',
      'Account and security',
      'Sign out',
    ]);
    const u = page.locator(cell('admin-unavailable'));
    await expect(u.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(u.getByRole('heading', { name: 'Administration is not available' })).toBeVisible();
    const d = page.locator(cell('admin-nav-disabled')).locator('[aria-disabled=true]');
    await expect(d).toHaveText('Usage report');
    await expect(d).not.toHaveAttribute('href');
  });

  test('responsive: five-item tab bar under 768 px, rail 64 px at 768 px, sidebar 240 px from 1024 px', async ({
    page,
  }) => {
    const nav = () => page.locator(`${cell('admin-auto')} nav[aria-label=Main]`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/gallery');
    expect((await nav().boundingBox())?.height).toBe(64);
    await expect(nav().getByRole('link')).toHaveCount(5);
    await page.setViewportSize({ width: 768, height: 1024 });
    expect(Math.round((await nav().boundingBox())?.width ?? 0)).toBe(64);
    await expect(
      page.locator(cell('admin-auto')).getByRole('link', { name: 'Accounts' }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(Math.round((await nav().boundingBox())?.width ?? 0)).toBe(240);
  });

  const SHOTS: Record<string, string[]> = {
    '1440': [
      'admin-sidebar',
      'admin-nav-states',
      'admin-no-alerts',
      'admin-many-alerts',
      'admin-rail',
      'admin-tabbar',
      'admin-menu',
      'admin-toast',
      'admin-nav-disabled',
      'admin-nav-focus',
      'admin-unavailable',
      'admin-auto',
    ],
    '390': [
      'admin-tabbar',
      'admin-menu',
      'admin-toast',
      'admin-nav-disabled',
      'admin-nav-focus',
      'admin-unavailable',
      'admin-auto',
    ],
    '768': ['admin-auto'],
  };
  for (const [name, ids] of Object.entries(SHOTS)) {
    test(`every state matches its baseline and has no axe violations at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({
        width: Number(name),
        height: name === '390' ? 844 : name === '768' ? 1024 : 900,
      });
      await page.goto('/gallery');
      await expectNoAxeViolations(
        page,
        `${evidence}/axe/${info.project.name}-shell-admin-${name}.json`,
      );
      await page.evaluate(() => document.fonts.ready);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      for (const id of ids) {
        const target = page.locator(cell(id));
        await expect(target).toHaveScreenshot(`${id}-${name}.png`);
        await target.screenshot({ path: `${evidence}/screenshots/${id}-${name}.png` });
      }
    });
  }
});
