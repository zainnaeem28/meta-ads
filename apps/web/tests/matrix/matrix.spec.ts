import { copyFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { relay, settle, signedIn } from '../a11y/support';
import { EVIDENCE, JOURNEYS, MIN_TOUCH, ensureDir, recordRun, recordVersion } from './support';

/**
 * TC-NFR-06 (NFR-06): sign-in and FLOW-01 to FLOW-04 smoke paths on chromium, the Edge channel, firefox, webkit and the
 * iOS Safari and Android Chrome device profiles, through the built web app (`next start`) against the running api.
 * The screen reads are labelled contract-shaped mocks (the a11y suite's screen groups); the sign-in page and every
 * request a script does not answer reach the real api. Each project compares with its own baseline, approved by UI/UX
 * (a later diff needs UI/UX approval before `--update-snapshots`, tests/support/visual.ts). Real devices are go-live (TC-H-09).
 */
const NOW = '2026-11-16T12:00:00.000Z';

/** Controls a finger has to hit: visible, interactive, not a link inside running text. */
async function smallTargets(page: Page) {
  return page.evaluate((min) => {
    const selector =
      'button, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"], [role="menuitem"], a[href], input:not([type="hidden"]), select, textarea, summary';
    const small: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.closest('[aria-hidden="true"],[hidden],.sr-only')) continue;
      if (el.matches('input[type="checkbox"],input[type="radio"]') && el.closest('label')) continue; // the label is the target
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue; // visually hidden on purpose
      if (box.bottom <= 0 || box.right <= 0 || box.left >= innerWidth) continue; // parked off screen (skip link until focused)
      // A link inside a sentence is an inline target (WCAG 2.5.8 exception); a link that is a block or a flex item is not.
      if (
        el.tagName === 'A' &&
        style.display === 'inline' &&
        el.parentElement?.textContent !== el.textContent
      )
        continue;
      if (box.width < min || box.height < min) {
        const label = (el.getAttribute('aria-label') || el.textContent || el.tagName)
          .trim()
          .slice(0, 40);
        small.push(
          `${el.tagName.toLowerCase()} "${label}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    return small;
  }, MIN_TOUCH);
}

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe('@matrix @TASK-117 browser and device matrix', () => {
  test.use({ timezoneId: 'UTC' });

  test('records the browser version of the project', async ({ browser, page }, info) => {
    const userAgent = await page.evaluate(() => navigator.userAgent);
    recordVersion(info.project.name, {
      project: info.project.name,
      browser: browser.browserType().name(),
      version: browser.version(),
      channel: info.project.use.channel ?? null,
      device: info.project.use.defaultBrowserType
        ? { isMobile: info.project.use.isMobile ?? false }
        : null,
      playwright: '1.65.1',
      userAgent,
    });
    expect(browser.version()).toMatch(/\d+\.\d+/);
  });

  for (const { flow, group } of JOURNEYS) {
    test(`${flow}: ${group.id} renders, fits the screen and matches the baseline`, async ({
      page,
      context,
      baseURL,
      isMobile,
    }, info) => {
      if (group.session) await signedIn(context, baseURL!);
      await relay(page, group.script);
      await page.clock.setFixedTime(NOW);
      await page.goto(group.path);
      await expect(page.getByText(group.ready, { exact: false }).first()).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await settle(page);

      expect(await sideways(page), `${flow}: page scrolls sideways`).toBeLessThanOrEqual(1);

      if (isMobile) {
        const small = await smallTargets(page);
        expect.soft(small, `${flow}: touch targets under ${MIN_TOUCH} px`).toEqual([]);
      }

      // The fixed phone tab bar would be drawn mid-page in a full-page capture; it is hidden for the picture only.
      const hideFixed = await page.addStyleTag({
        content: '.fixed { visibility: hidden !important; }',
      });
      const name = `${group.id}.png`;
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(name, { fullPage: true });
      if (process.env.EVIDENCE === '1') {
        ensureDir(`${EVIDENCE}/screenshots`);
        copyFileSync(
          info.snapshotPath(name),
          `${EVIDENCE}/screenshots/${info.project.name}-${group.id}.png`,
        );
      }
      await hideFixed.evaluate((el) => el.remove());

      if (isMobile) {
        await page.setViewportSize({ width: 320, height: 640 });
        await settle(page);
        expect(
          await sideways(page),
          `${flow}: page scrolls sideways at 320 px`,
        ).toBeLessThanOrEqual(1);
      }
      recordRun(info.project.name, { journey: flow, ok: true });
    });
  }
});
