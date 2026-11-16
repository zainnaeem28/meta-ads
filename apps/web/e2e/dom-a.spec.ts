import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-076';

test.describe('@TASK-076 job card, claim issue, segment editor (CMP-022, 023, 024) through the built web app', () => {
  test('every job state and failure cause is reachable with named actions', async ({ page }) => {
    await page.goto('/gallery');
    const cards = page.locator('[data-testid=job-cards] article');
    expect(
      await cards.evaluateAll((els) =>
        els.map((e) => [e.getAttribute('data-state'), e.getAttribute('data-cause')]),
      ),
    ).toEqual([
      ['pending', null],
      ['created', null],
      ['processing', null],
      ['completed', null],
      ['failed', 'temporary'],
      ['failed', 'configuration'],
      ['failed', 'unknown'],
      ['completed', null],
      ['completed', null],
    ]);
    await expect(page.getByRole('button', { name: /^Generate segment/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Retry segment/ })).toHaveCount(2);
    await expect(page.locator('[data-qc]')).toHaveCount(3);
  });

  test('claim issue: high risk has no clear action; other needs a reason; closed is inert', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const high = page.getByRole('article', { name: 'High risk claim issue, segment 1' });
    await expect(high.getByRole('button')).toHaveCount(0);
    const other = page.getByRole('article', { name: 'Other claim issue, segment 2' });
    const clear = other.getByRole('button', { name: 'Clear issue for segment 2' });
    await expect(clear).toBeDisabled();
    await other.getByLabel('Reason for clearing').fill('Evidence on file');
    await expect(clear).toBeEnabled();
    await expect(page.locator('[data-testid=claim-issues] [data-state=closed] button')).toHaveCount(
      0,
    );
  });

  test('segment editor zones follow the word count', async ({ page }) => {
    await page.goto('/gallery');
    const zones = await page
      .locator('[data-testid=segment-editors] [data-case] section')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-zone')));
    expect(zones).toEqual(['short', 'within', 'blocked', 'within', 'within']);
    const live = page.locator('[data-testid=live-editor]');
    const box = live.getByLabel('Segment 2 dialogue');
    await box.fill(Array.from({ length: 46 }, () => 'a').join(' '));
    await expect(live.locator('section')).toHaveAttribute('data-zone', 'blocked');
    await expect(live.getByRole('status')).toHaveText(/46 words, over the 45 word limit/);
  });

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`gallery matches its baseline and has no axe violations at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const section = page.locator('[data-testid=dom-a]');
      await expectNoAxeViolations(page, `${evidence}/axe/${info.project.name}-dom-a-${name}.json`);
      await page.evaluate(() => document.fonts.ready);
      const clipped = await section.locator('[data-variant]').evaluateAll((els) =>
        els
          .filter((e) => e.scrollWidth > e.clientWidth || !e.closest('article, section')?.contains(e))
          .filter((e) => {
            const a = e.getBoundingClientRect();
            const c = e.closest('article')?.getBoundingClientRect();
            return c ? a.right > c.right + 0.5 || a.left < c.left - 0.5 : false;
          })
          .map((e) => e.textContent),
      );
      expect(clipped, 'badges must stay inside their card').toEqual([]);
      await expect(section).toHaveScreenshot(`dom-a-${name}.png`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await section.screenshot({ path: `${evidence}/screenshots/dom-a-${name}.png` });
    });
  }
});
