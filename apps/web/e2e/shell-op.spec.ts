import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-079';
const cell = (id: string) => `[data-cell=${id}]`;

test.describe('@TASK-079 operator shell (CMP-030) through the built web app', () => {
  test('sidebar: skip link first, landmarks, three items in order, current marked', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    const c = page.locator(cell('shell-nav-states'));
    await expect(c.locator('header')).toBeVisible();
    await expect(c.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(c.getByRole('main')).toBeVisible();
    const links = c.getByRole('navigation', { name: 'Main' }).getByRole('link');
    await expect(links).toHaveText(['Campaigns', 'New brief', 'Provider keys']);
    await expect(links.nth(1)).toHaveAttribute('aria-current', 'page');
    const width = await c.getByRole('navigation', { name: 'Main' }).evaluate((e) => e.getBoundingClientRect().width);
    expect(Math.round(width)).toBe(240);
  });

  test('keyboard: Tab reaches the skip link first and the focus ring shows on nav items', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    const c = page.locator(cell('shell-user-sidebar'));
    await page.waitForLoadState('networkidle');
    await c.getByRole('link', { name: 'Skip to content' }).focus();
    await expect(c.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(c.getByRole('link', { name: 'ShrooMap home' })).toBeFocused();
    await c.getByRole('link', { name: 'Campaigns' }).focus();
    await page.keyboard.press('Tab');
    await expect(c.getByRole('link', { name: 'New brief' })).toBeFocused();
    const outline = await c.getByRole('link', { name: 'New brief' }).evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(outline).not.toBe('none');
  });

  test('avatar menu: admin sees the switch, operator does not, Account and security is listed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    const admin = page.locator(cell('shell-admin'));
    await expect(admin.getByRole('menuitem')).toHaveText(['Provider keys', 'Switch to administration', 'Account and security', 'Sign out']);
    await expect(admin.getByText('Signed in as Administrator')).toBeVisible();
    const user = page.locator(cell('shell-menu-user'));
    await expect(user.getByRole('menuitem', { name: 'Switch to administration' })).toHaveCount(0);
    await expect(user.getByText('Signed in as Operator')).toBeVisible();
  });

  test('key badge links to the key screen, warning and destructive', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    const missing = page.locator(cell('shell-key-missing')).getByRole('link', { name: 'Add provider keys' });
    await expect(missing).toHaveAttribute('href', '/settings/provider-keys');
    await expect(missing.locator('[data-variant=warning]')).toBeVisible();
    const disabled = page.locator(cell('shell-key-disabled')).getByRole('link', { name: 'Key disabled' });
    await expect(disabled.locator('[data-variant=destructive]')).toBeVisible();
    await disabled.click({ trial: true });
    await expect(page.locator(cell('shell-toast')).getByText('Brief saved.')).toBeVisible();
  });

  test('disabled nav item is not a link and not focusable; focus rings are drawn', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    const d = page.locator(cell('shell-nav-disabled')).getByRole('navigation', { name: 'Main' });
    await expect(d.getByRole('link')).toHaveText(['Campaigns', 'Provider keys']);
    const item = d.locator('[aria-disabled=true]');
    await expect(item).toHaveText('New brief');
    await expect(item).not.toHaveAttribute('href');
    await expect(item).not.toHaveAttribute('tabindex');
    for (const [id, name] of [['shell-nav-focus', 'Provider keys'], ['shell-key-focus', 'Add provider keys']]) {
      const link = page.locator(cell(id)).getByRole('link', { name });
      expect(await link.evaluate((e) => getComputedStyle(e).outlineWidth)).toBe('2px');
    }
  });

  test('responsive: tab bar under 768 px, rail 64 px at 768 px, sidebar 240 px from 1024 px', async ({ page }) => {
    const nav = () => page.locator(`${cell('shell-auto')} nav[aria-label=Main]`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/gallery');
    expect((await nav().boundingBox())?.height).toBe(64);
    await page.setViewportSize({ width: 768, height: 1024 });
    expect(Math.round((await nav().boundingBox())?.width ?? 0)).toBe(64);
    await expect(page.locator(cell('shell-auto')).getByRole('link', { name: 'Campaigns' })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(Math.round((await nav().boundingBox())?.width ?? 0)).toBe(240);
  });

  test('collapsed rail keeps labels as titles and accessible names', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery');
    const link = page.locator(cell('shell-rail')).getByRole('link', { name: 'Provider keys' });
    await expect(link).toHaveAttribute('title', 'Provider keys');
    expect(Math.round((await link.evaluate((e) => e.getBoundingClientRect().width)))).toBeLessThanOrEqual(64);
  });

  const SHOTS: Record<string, string[]> = {
    '1440': ['shell-user-sidebar', 'shell-nav-states', 'shell-rail', 'shell-tabbar', 'shell-menu-user', 'shell-admin', 'shell-key-missing', 'shell-key-disabled', 'shell-toast', 'shell-nav-disabled', 'shell-nav-focus', 'shell-key-focus', 'shell-auto'],
    '390': ['shell-tabbar', 'shell-menu-user', 'shell-admin', 'shell-key-missing', 'shell-key-disabled', 'shell-toast', 'shell-nav-disabled', 'shell-nav-focus', 'shell-key-focus', 'shell-auto'],
    '768': ['shell-auto'],
  };
  for (const [name, ids] of Object.entries(SHOTS)) {
    test(`every state matches its baseline and has no axe violations at ${name} px`, async ({ page }, info) => {
      await page.setViewportSize({ width: Number(name), height: name === '390' ? 844 : name === '768' ? 1024 : 900 });
      await page.goto('/gallery');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-shell-${name}.json`);
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
