import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';
import { LOCAL_DEV_PASSWORD } from '../src/lib/auth/local-dev';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../src/lib/auth/local-session';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-087';
const SHOTS = VIEWPORTS.filter((v) => v.name !== '768');

const session = async (context: BrowserContext, baseURL: string) =>
  context.addCookies([
    {
      name: LOCAL_SESSION_COOKIE,
      value: await signLocalSession({
        sub: 'user_local_e2e',
        email: 'e2e@example.com',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      url: baseURL,
    },
  ]);

test.describe('@TASK-087 SCREEN-001 and SCREEN-003 through the built web app (local mode)', () => {
  test('sign-in has the one h1 and keyboard-only operation reaches the submit', async ({
    page,
  }) => {
    await page.goto('/sign-in', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI UGC Ad Director');
    await page.getByLabel('Email address').focus();
    await page.keyboard.type('operator@example.com');
    await page.keyboard.press('Tab');
    await page.keyboard.type(LOCAL_DEV_PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/campaigns$/, { timeout: 20_000 });
  });

  test('session-expired shows the exact message above the form', async ({ page }) => {
    await page.goto('/sign-in?reason=session-expired&return=%2Fcampaigns');
    const message = page.getByText('Your session ended. Sign in to continue.');
    await expect(message).toBeVisible();
    const [m, f] = await Promise.all([
      message.boundingBox(),
      page.getByLabel('Email address').boundingBox(),
    ]);
    expect(m!.y).toBeLessThan(f!.y);
  });

  test('mfa enrol and challenge say that recovery re-proves a second factor; a wrong code shows the error', async ({
    page,
    context,
    baseURL,
  }) => {
    await session(context, baseURL!);
    await page.goto('/mfa?step=enrol');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Set up two-step verification',
    );
    await expect(page.getByTestId('mfa-recovery')).toContainText(
      'Recovery needs another second factor',
    );
    await expect(
      page.getByText('Two-step verification is required. Set it up to continue.'),
    ).toBeVisible();
    await page.goto('/mfa?reason=mfa_required');
    await expect(
      page.getByText('Two-step verification is required. Set it up to continue.'),
    ).toBeVisible();
    await page.goto('/mfa');
    await expect(page.getByText('Two-step verification is required.')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Two-step verification');
    await page.getByLabel('6-digit code').fill('111111');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('That code is not right or has expired')).toBeVisible();
  });

  for (const { name, width, height } of SHOTS) {
    for (const state of ['mfa-enrol', 'mfa-error'] as const) {
      test(`${state} at ${name} px: axe and a screenshot`, async ({
        page,
        context,
        baseURL,
      }, info) => {
        await page.setViewportSize({ width, height });
        await session(context, baseURL!);
        await page.goto(state === 'mfa-enrol' ? '/mfa?step=enrol' : '/mfa');
        if (state === 'mfa-error') {
          await page.getByLabel('6-digit code').fill('111111');
          await page.getByRole('button', { name: 'Verify' }).click();
          await expect(page.getByText('That code is not right')).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await expectNoAxeViolations(
          page,
          `${evidence}/axe/${info.project.name}-${state}-${name}.json`,
        );
        mkdirSync(`${evidence}/screenshots`, { recursive: true });
        await page.screenshot({
          path: `${evidence}/screenshots/${state}-${name}.png`,
          fullPage: true,
        });
        await expect(page).toHaveScreenshot(`fe-screen-001-003-${state}-${name}.png`, {
          fullPage: true,
        });
      });
    }
  }
});
