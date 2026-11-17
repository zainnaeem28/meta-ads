import { copyFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { AXE_TAGS, expectNoAxeViolations } from '../support/axe';
import { GROUPS, type Group } from './groups';
import {
  EVIDENCE,
  TEXT_SPACING_CSS,
  ensureDir,
  expectNoLoss,
  relay,
  settle,
  signedIn,
  visibleText,
} from './support';

/**
 * UI-UX §12 on the running application, one real page per screen group (groups.ts):
 * 320 px reflow, 200 % zoom, the text-spacing override, contrast, reduced motion, keyboard order and focus return.
 * Built web app (`next start`) against the running api; the screen reads are labelled contract-shaped mocks.
 * Captures use the real fonts and are compared with the approved baselines in __baselines__/chromium.
 */
const VARIANTS = [
  { name: 'reflow-320', width: 320, height: 640, css: '' },
  { name: 'zoom-640', width: 640, height: 450, css: '' }, // 1280 CSS px at 200 % zoom
  { name: 'spacing-390', width: 390, height: 844, css: TEXT_SPACING_CSS },
  { name: 'spacing-1440', width: 1440, height: 900, css: TEXT_SPACING_CSS },
] as const;

/** Navigation labels the phone layout moves into the tab bar and its menu (UI-UX §7); they stay reachable there. */
const WIDE_SHELL = ['Workspace', 'Administration', 'Invitations', 'Usage report'];

const mainText = async (page: Page) =>
  new Set((await visibleText(page)).filter((t) => t.length > 0).map((t) => t.replace(/\s+/g, ' ')));

async function open(page: Page, g: Group, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await relay(page, g.script);
  await page.clock.setFixedTime('2026-11-16T12:00:00.000Z');
  const res = await page.goto(g.path);
  if (g.id === 'not-found') expect(res?.status()).toBe(404);
  await expect(page.getByText(g.ready, { exact: false }).first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await settle(page);
}

for (const g of GROUPS) {
  test.describe(`@a11y @TASK-118 ${g.id} (${g.screens.join(', ')})`, () => {
    test.use({ timezoneId: 'UTC' });
    test.beforeEach(async ({ context, baseURL, browserName }) => {
      test.skip(browserName !== 'chromium');
      if (g.session) await signedIn(context, baseURL!);
    });

    test('reflow, 200 % zoom and text spacing: no loss of content, no axe violation, baseline match', async ({
      page,
    }, info) => {
      await open(page, g, { width: 1440, height: 900 });
      const reference = await mainText(page);
      expect(reference.size, 'the page has content to compare').toBeGreaterThan(0);

      for (const v of VARIANTS) {
        await page.setViewportSize({ width: v.width, height: v.height });
        const style = v.css ? await page.addStyleTag({ content: v.css }) : null;
        await settle(page);
        await expectNoLoss(page, `${g.id} ${v.name}`);
        const text = await mainText(page);
        // Anything a reader had at 1440 px is still there; wording shown only in a wide layout is declared per group.
        const missing = [...reference].filter(
          (t) => !text.has(t) && !(g.wideOnly ?? []).includes(t) && !WIDE_SHELL.includes(t),
        );
        expect(missing, `${g.id} ${v.name}: text no longer shown`).toEqual([]);
        await expectNoAxeViolations(
          page,
          `${EVIDENCE}/axe/${info.project.name}-wcag-${g.id}-${v.name}.json`,
        );
        const full = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width: v.width, height: Math.max(v.height, full) });
        await settle(page);
        // The fixed phone tab bar would be drawn mid-page in a full-page capture; it is hidden for the picture only (it stays in the axe run above).
        const hideFixed = await page.addStyleTag({
          content: '.fixed { visibility: hidden !important; }',
        });
        const baseline = `a11y-${g.id}-${v.name}.png`;
        await expect(page).toHaveScreenshot(baseline, { fullPage: true });
        if (process.env.EVIDENCE === '1') {
          ensureDir(`${EVIDENCE}/screenshots`);
          copyFileSync(
            info.snapshotPath(baseline),
            `${EVIDENCE}/screenshots/${g.id}-${v.name}.png`,
          );
        }
        await hideFixed.evaluate((el) => el.remove());
        await style?.evaluate((el) => el.remove());
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    });

    test('contrast: axe colour-contrast finds nothing at phone and desktop widths', async ({
      page,
    }) => {
      for (const size of [
        { width: 390, height: 844 },
        { width: 1440, height: 900 },
      ]) {
        await open(page, g, size);
        const { violations } = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .withRules(['color-contrast'])
          .analyze();
        expect(violations, `${g.id} ${size.width}: contrast`).toEqual([]);
      }
    });

    test('keyboard only: Tab order follows the page, every stop is visible with a focus ring, nothing uses a positive tabindex', async ({
      page,
    }) => {
      await open(page, g, { width: 1440, height: 900 });
      const positive = await page
        .locator('[tabindex]')
        .evaluateAll((els) => els.filter((e) => Number(e.getAttribute('tabindex')) > 0).length);
      expect(positive, 'positive tabindex').toBe(0);
      const stops: { index: number; ring: boolean; visible: boolean; label: string }[] = [];
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const all = Array.from(document.querySelectorAll('*'));
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          const ring =
            (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
          const child = el.querySelector(':focus-visible');
          return {
            index: all.indexOf(el),
            ring: ring || !!child || el.matches(':focus-visible'),
            visible: r.width > 0 && r.height > 0,
            label: (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName)
              .trim()
              .slice(0, 40),
          };
        });
        if (!stop) break;
        if (stops.length && stops[0]!.index === stop.index) break; // wrapped around
        stops.push(stop);
      }
      expect(stops.length, 'the page has keyboard stops').toBeGreaterThan(0);
      expect(
        stops.filter((s) => !s.visible).map((s) => s.label),
        'invisible focus stops',
      ).toEqual([]);
      expect(
        stops.filter((s) => !s.ring).map((s) => s.label),
        'stops with no focus indicator',
      ).toEqual([]);
      const order = stops.map((s) => s.index);
      expect(order, 'tab order is document order').toEqual([...order].sort((a, b) => a - b));
    });

    test('reduced motion: the preference is honoured and nothing keeps animating', async ({
      page,
    }) => {
      await open(page, g, { width: 1440, height: 900 });
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      ).toBe(true);
      const moving = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running')
          .filter((a) => {
            const el = (a.effect as KeyframeEffect | null)?.target as
              HTMLElement | null | undefined;
            return (
              !!el &&
              !!el.getClientRects().length &&
              !el.closest('.invisible,[hidden],[aria-hidden="true"]')
            );
          })
          .map((a) => {
            const t = a.effect?.getTiming();
            const target = (a.effect as KeyframeEffect | null)?.target as
              Element | null | undefined;
            return {
              target: `${target?.tagName ?? ''}.${target?.getAttribute('class') ?? ''} in ${target?.parentElement?.tagName ?? ''}.${target?.parentElement?.getAttribute('class') ?? ''}`,
              duration: Number(t?.duration ?? 0),
              iterations: t?.iterations,
            };
          })
          .filter((a) => a.duration > 50),
      );
      expect(moving, 'running animations under reduced motion').toEqual([]);
    });

    if (g.dialog) {
      const d = g.dialog;
      test('focus order and return: Enter opens the dialog, Escape closes it, focus goes back to the control', async ({
        page,
      }) => {
        await open(page, g, { width: 1440, height: 900 });
        const trigger = page.getByRole('button', { name: d.trigger });
        await trigger.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole(d.dialog as 'dialog');
        await expect(dialog).toBeVisible();
        const inside = await page.evaluate(
          () => !!document.activeElement?.closest('[role="alertdialog"],[role="dialog"]'),
        );
        expect(inside, 'focus moved into the dialog').toBe(true);
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press('Tab');
          expect(
            await page.evaluate(
              () => !!document.activeElement?.closest('[role="alertdialog"],[role="dialog"]'),
            ),
            'focus stays trapped',
          ).toBe(true);
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
      });
    }
  });
}
