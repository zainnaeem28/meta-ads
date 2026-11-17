import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { INVENTORY, LIVE_IDS, type Action, type StateEntry } from '../../src/app/gallery/inventory';
import { expectNoAxeViolations } from '../support/axe';
import { VIEWPORTS } from '../support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-081';
const WIDTHS = VIEWPORTS.filter((v) => v.name !== '768');

async function openGallery(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto('/gallery');
  await page.waitForLoadState('networkidle'); // hydrated: handlers are attached
  await page.evaluate(() => document.fonts.ready);
}

/** What a hover, focus or press visibly changes. */
const look = (l: Locator) =>
  l.evaluate((e) => {
    const c = getComputedStyle(e);
    return [
      c.backgroundColor,
      c.color,
      c.borderTopColor,
      c.boxShadow,
      c.outlineStyle,
      c.outlineColor,
      c.textDecorationLine,
      c.transform,
    ].join('|');
  });

async function perform(page: Page, action: Action) {
  if (action.kind === 'click') {
    for (const on of action.on) await page.locator(on).first().click();
    return;
  }
  const target = page.locator(action.on).first();
  await target.scrollIntoViewIfNeeded();
  const before = await look(target);
  if (action.kind === 'hover') await target.hover();
  else if (action.kind === 'focus') await target.focus();
  else {
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
  await expect
    .poll(() => look(target), { message: `${action.kind} changes how ${action.on} looks` })
    .not.toBe(before);
  if (action.kind === 'press') await page.mouse.up();
}

async function expectState(page: Page, st: StateEntry) {
  if (st.action) await perform(page, st.action);
  const hit = page.locator(st.selector).first();
  if (st.expect === 'hidden') await expect(hit).toHaveCount(0);
  else await expect(hit, `${st.state}: ${st.selector}`).toBeAttached();
}

test.describe('@TASK-081 gallery completion through the built web app', () => {
  test('registry: every live CMP ID of UI-UX §6 has a gallery section or cell and nothing else is registered', async ({
    page,
  }) => {
    await openGallery(page, 1440, 900);
    expect(LIVE_IDS).toHaveLength(32);
    // Every CMP ID the page names is a live one (CMP-009 is reserved, CMP-029 never existed).
    const named = await page.evaluate(() => {
      const ids = new Set<string>();
      for (const e of document.querySelectorAll(
        '[data-testid=gallery] h2, [data-testid=gallery] [data-cell] > span:first-child',
      )) {
        for (const m of (e.textContent ?? '').matchAll(/CMP-\d{3}/g)) ids.add(m[0]);
      }
      return [...ids];
    });
    expect(
      named.filter((id) => !LIVE_IDS.includes(id)),
      'gallery names an ID outside the inventory',
    ).toEqual([]);
    // The page nav lists every gallery section; each live ID is either a section or inside one.
    const sections = await page.locator('[data-testid=gallery] section[id^=CMP-]').count();
    expect(sections).toBeGreaterThanOrEqual(14);
  });

  for (const vp of WIDTHS) {
    test.describe(`states at ${vp.name} px`, () => {
      for (const entry of INVENTORY) {
        test(`${entry.id} ${entry.name}: every listed state is on the page (${entry.sheet})`, async ({
          page,
        }) => {
          await openGallery(page, vp.width, vp.height);
          const failures: string[] = [];
          for (const st of entry.states) {
            // A fresh page per interaction state keeps one state from changing the next.
            if (st.action) await openGallery(page, vp.width, vp.height);
            try {
              await expectState(page, st);
            } catch (e) {
              failures.push(`${st.state}: ${(e as Error).message.split('\n')[0]}`);
            }
          }
          expect(failures, `${entry.id} states with no entry`).toEqual([]);
        });
      }
    });
  }

  for (const vp of WIDTHS) {
    test(`axe: the whole gallery has no violations at ${vp.name} px`, async ({ page }) => {
      await openGallery(page, vp.width, vp.height);
      mkdirSync(`${evidence}/axe`, { recursive: true });
      await expectNoAxeViolations(page, `${evidence}/axe/gallery-${vp.name}.json`);
    });

    test(`axe: dialog (confirm, typed, form, discard) open at ${vp.name} px`, async ({ page }) => {
      await openGallery(page, vp.width, vp.height);
      for (const [open, title] of [
        ['Open confirm', 'Pause campaign?'],
        ['Open typed confirm', 'Delete campaign'],
        ['Open form dialog', 'Rename campaign'],
      ] as const) {
        await page.getByRole('button', { name: open }).click();
        const overlay = page.getByTestId('dialog-overlay');
        await expect(overlay.getByRole('dialog', { name: title })).toBeVisible();
        await expectNoAxeViolations(
          page,
          `${evidence}/axe/dialog-${title.replace(/\W+/g, '-')}-${vp.name}.json`,
        );
        await page.keyboard.press('Escape');
        await expect(overlay).toHaveCount(0);
      }
    });
  }

  for (const vp of WIDTHS) {
    test(`baselines at ${vp.name} px: one per component, approved by UI/UX`, async ({ page }) => {
      await openGallery(page, vp.width, vp.height);
      for (const entry of INVENTORY) {
        const anchor = page.locator(entry.anchor).first();
        await anchor.scrollIntoViewIfNeeded();
        await expect(anchor).toHaveScreenshot(`gallery-${entry.id}-${vp.name}.png`);
      }
    });
  }

  test('screenshots for the evidence folder: each sheet at 390 and 1440 px', async ({ page }) => {
    mkdirSync(`${evidence}/screenshots`, { recursive: true });
    for (const vp of WIDTHS) {
      await openGallery(page, vp.width, vp.height);
      for (const entry of INVENTORY) {
        const anchor = page.locator(entry.anchor).first();
        await anchor.scrollIntoViewIfNeeded();
        await anchor.screenshot({
          path: `${evidence}/screenshots/${entry.sheet}-${entry.id}-${vp.name}.png`,
        });
      }
    }
  });
});
