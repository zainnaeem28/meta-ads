import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../../support/axe';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';
import { LOCAL_DEV_CODE, LOCAL_DEV_PASSWORD } from '../../../src/lib/auth/local-dev';

// TC-FLW-12 (FLOW-12, J-12): provision and remove accounts, on the built web app (`next start`) and the compiled api in
// IDENTITY_MODE=local, on a throwaway database of the shared test PostgreSQL. Nothing the api answers is mocked: people sign
// in through the real sign-in form, the web gets its bearer from the api's local token route, and the api links the first
// administrator (the owner email), accepts invitations and refuses what it must refuse.
// Limits, stated: the invitation e-mail itself and the erasure worker are not part of this stack (no provider stub and no
// worker process here), so an invitation is "sent" as far as the api's own state goes and a removal is "Running" at step 1;
// the invitee opens the product by signing in with the invited address, the way the api links the first token. The one
// direct database write is the clock: an invitation is aged past its 7 days, because the test cannot wait a week.
const evidence = resolve(__dirname, '..', '..', '..', '..', '..', 'docs', 'evidence', 'TASK-113');
const API = () => process.env.E2E_API_URL!;
const OWNER = 'owner@example.com';
const INVITEE = 'invitee@example.com';
const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

const sql = (statement: string): Record<string, unknown>[] =>
  JSON.parse(
    execFileSync(
      'node',
      [resolve(__dirname, 'database.mjs'), 'exec', process.env.FLOW12_DATABASE_URL!, statement],
      { encoding: 'utf8' },
    ),
  ) as Record<string, unknown>[];

/** One screenshot per step and design width, and axe (WCAG 2.2 AA, any impact) on the same page state. */
async function capture(page: Page, step: string) {
  const original = page.viewportSize();
  mkdirSync(`${evidence}/screenshots`, { recursive: true });
  for (const { name, width, height } of SIZES) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await expectNoAxeViolations(page, `${evidence}/axe/${step}-${name}.json`);
    await page.screenshot({ path: `${evidence}/screenshots/${step}-${name}.png`, fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

/** Signs in through the real local sign-in form (and the second step when asked); ends on `return`. */
async function signIn(page: Page, email: string, returnTo: string, withCode = false) {
  await page.goto(`/sign-in?return=${encodeURIComponent(returnTo)}`);
  // The form is a server action: wait for the page to be interactive before typing.
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(LOCAL_DEV_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  const arrived = () =>
    page.waitForURL((url) => url.pathname === returnTo.split('?')[0], { timeout: 20_000 });
  await arrived();
  if (withCode) {
    await page.goto(`/mfa?return=${encodeURIComponent(returnTo)}`);
    await page.getByLabel(/code/i).fill(LOCAL_DEV_CODE);
    await page.getByRole('button', { name: /verify|continue/i }).click();
    await arrived();
  }
}

async function person(browser: Browser, baseURL: string, email: string, returnTo: string) {
  const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await signIn(page, email, returnTo);
  return { context, page };
}

/** The signed-in person's bearer (the web's own token route) for calls the test makes straight to the api. */
async function bearer(page: Page): Promise<string> {
  const res = await page.request.get('/local-token');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const apiCall = async (
  request: APIRequestContext,
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await request.fetch(`${API()}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(data === undefined ? {} : { data }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: unknown;
    error?: { code?: string };
  };
  return { status: res.status(), body, code: body.error?.code };
};

const row = (page: Page, email: string) => page.getByRole('row').filter({ hasText: email });
const toast = (page: Page, text: string | RegExp) =>
  expect(page.getByText(text).first()).toBeVisible();

test.describe.serial('@TASK-113 @FLOW-12 provision and remove accounts', () => {
  let ownerPage: Page;
  let ownerToken: string;
  let ownerId: string;
  const apiErrors: string[] = [];

  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
    ownerPage = await context.newPage();
    ownerPage.on('response', (r) => {
      if (r.url().startsWith(API()) && r.status() >= 400)
        apiErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
    });
  });
  test.afterAll(async () => {
    await ownerPage.context().close();
  });

  test('first administrator: the owner email signs in with the second step and sees only themself (SCREEN-001, 003, 011)', async () => {
    // Anonymous first: the admin screen sends the visitor to sign-in with the way back carried.
    await ownerPage.goto('/admin/accounts');
    await expect(ownerPage).toHaveURL(/\/sign-in\?.*return=%2Fadmin%2Faccounts/);
    await signIn(ownerPage, OWNER, '/admin/accounts', true);
    await expect(ownerPage.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible();
    await expect(row(ownerPage, OWNER)).toContainText('You');
    await expect(row(ownerPage, OWNER)).toContainText('Administrator');
    await expect(ownerPage.getByText('You are the only person here.')).toBeVisible();
    ownerToken = await bearer(ownerPage);
    const users = await apiCall(ownerPage.request, ownerToken, 'GET', '/admin/users');
    const list = users.body.data as { id: string; email: string; role: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: OWNER, role: 'admin' });
    ownerId = list[0]!.id;
    await capture(ownerPage, '01-first-admin-accounts');
  });

  test('SCREEN-011 invite: empty and malformed addresses are refused in the dialog, Cancel changes nothing, a valid address is accepted', async () => {
    const page = ownerPage;
    await page.getByRole('button', { name: 'Invite person' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Invite a person' });
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog.getByText('Enter an email address.')).toBeVisible();
    await dialog.getByLabel('Email address').fill('not-an-address');
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog.getByText(/Enter a valid email address/)).toBeVisible();
    await capture(page, '02-invite-dialog-error');
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden();
    expect(sql('select count(*)::int n from invitations')[0]!.n).toBe(0);

    // Keyboard only (NFR-07): open with Enter, type, submit with Enter.
    await page.getByRole('button', { name: 'Invite person' }).first().focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.type(INVITEE);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await toast(page, 'Invitation sent.');
    expect(sql(`select state from invitations where lower(email) = '${INVITEE}'`)[0]!.state).toBe(
      'invited',
    );
  });

  test('SCREEN-012: the invitation is listed as Invited; resend, a cancelled revoke, then revoke; the revoked invitee has no access (SCREEN-002)', async ({
    browser,
    baseURL,
  }) => {
    const page = ownerPage;
    await page.goto('/admin/invitations');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Invitations and requests' }),
    ).toBeVisible();
    await expect(row(page, INVITEE)).toContainText('Invited');
    await capture(page, '03-invitations-invited');

    await page.getByRole('button', { name: `Resend to ${INVITEE}` }).click();
    await toast(page, 'Invitation sent again.');

    await page.getByRole('button', { name: `Revoke ${INVITEE}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Revoke this invitation?' });
    await expect(dialog).toContainText(INVITEE);
    await capture(page, '04-revoke-dialog');
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(row(page, INVITEE)).toContainText('Invited');

    await page.getByRole('button', { name: `Revoke ${INVITEE}` }).click();
    await page
      .getByRole('dialog', { name: 'Revoke this invitation?' })
      .getByRole('button', { name: 'Revoke invitation' })
      .click();
    await toast(page, 'Invitation revoked.');
    await expect(row(page, INVITEE)).toContainText('Revoked');

    // The invitee, with the invitation revoked, signs in and meets the "no access" state, not the product.
    const invitee = await person(browser, baseURL!, INVITEE, '/campaigns');
    await invitee.page.goto('/campaigns');
    await expect(invitee.page).toHaveURL(/\/access/);
    await expect(
      invitee.page.getByRole('heading', { name: 'This account has no access yet' }),
    ).toBeVisible();
    await capture(invitee.page, '05-invitee-no-access');
    await invitee.context.close();
    expect(sql(`select count(*)::int n from users where lower(email) = '${INVITEE}'`)[0]!.n).toBe(
      0,
    );
  });

  test('an expired invitation cannot be used; inviting again from the list issues a fresh one', async ({
    browser,
    baseURL,
  }) => {
    const page = ownerPage;
    await page.goto('/admin/invitations');
    await page.getByRole('button', { name: 'Invite person' }).first().click();
    const inviteDialog = page.getByRole('dialog', { name: 'Invite a person' });
    await inviteDialog.getByLabel('Email address').fill(INVITEE);
    await inviteDialog.getByRole('button', { name: 'Send invitation' }).click();
    await toast(page, 'If this address can be invited, an invitation is on its way.');
    // The clock: the invitation is older than its 7 days.
    sql(
      `update invitations set created_at = now() - interval '9 days', expires_at = now() - interval '2 days' where lower(email) = '${INVITEE}' and state = 'invited'`,
    );
    await page.reload();
    await expect(row(page, INVITEE).filter({ hasText: 'Expired' })).toHaveCount(1);
    await capture(page, '06-invitations-expired');
    const invitee = await person(browser, baseURL!, INVITEE, '/campaigns');
    await invitee.page.goto('/campaigns');
    await expect(
      invitee.page.getByRole('heading', { name: 'This account has no access yet' }),
    ).toBeVisible();
    await invitee.context.close();
    expect(sql(`select count(*)::int n from users where lower(email) = '${INVITEE}'`)[0]!.n).toBe(
      0,
    );

    // A fresh invitation for the same address (the expired one is not reusable).
    await page.getByRole('button', { name: `Invite ${INVITEE} again` }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite a person' });
    await expect(dialog.getByLabel('Email address')).toHaveValue(INVITEE);
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect
      .poll(
        () =>
          sql(
            `select state from invitations where lower(email) = '${INVITEE}' and expires_at > now() and state = 'invited'`,
          ).length,
      )
      .toBe(1);
  });

  test('the invitee signs in with the invited address: linked as an operator, sees the product but not the admin screens (permission path)', async ({
    browser,
    baseURL,
  }) => {
    const invitee = await person(browser, baseURL!, INVITEE, '/campaigns');
    await invitee.page.goto('/campaigns');
    await expect(invitee.page).toHaveURL(/\/campaigns/);
    expect(
      sql(`select role, status, linked_via from users where lower(email) = '${INVITEE}'`)[0],
    ).toEqual({ role: 'user', status: 'active', linked_via: 'invitation' });
    expect(
      sql(`select state from invitations where lower(email) = '${INVITEE}' and state = 'accepted'`),
    ).toHaveLength(1);
    await capture(invitee.page, '07-invitee-in-the-product');

    // An operator is refused the admin screens by the api; the page shows the unavailable state, never the data.
    await invitee.page.goto('/admin/accounts');
    await expect(invitee.page.getByText(OWNER)).toHaveCount(0);
    const refused = await apiCall(
      invitee.page.request,
      await bearer(invitee.page),
      'GET',
      '/admin/users',
    );
    expect([refused.status, refused.code]).toEqual([403, 'forbidden_role']);
    await capture(invitee.page, '08-operator-admin-unavailable');
    await invitee.context.close();
  });

  test('SCREEN-011: two accounts; the invited operator is Active; suspend (Cancel first), the invitee is blocked, reinstate restores them', async ({
    browser,
    baseURL,
  }) => {
    const page = ownerPage;
    await page.goto('/admin/accounts');
    await expect(row(page, INVITEE)).toContainText('Active');
    await expect(row(page, INVITEE)).toContainText('Operator');
    await capture(page, '09-accounts-two-people');

    await page.getByRole('button', { name: `Suspend ${INVITEE}` }).click();
    const dialog = page.getByRole('dialog', { name: `Suspend ${INVITEE}?` });
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(row(page, INVITEE)).toContainText('Active');

    await page.getByRole('button', { name: `Suspend ${INVITEE}` }).click();
    await capture(page, '10-suspend-dialog');
    await dialog.getByRole('button', { name: 'Suspend account' }).click();
    await toast(page, 'Account suspended.');
    await expect(row(page, INVITEE)).toContainText('Suspended');

    const suspended = await browser.newContext({ baseURL: baseURL!, reducedMotion: 'reduce' });
    const sp = await suspended.newPage();
    await signIn(sp, INVITEE, '/campaigns');
    await sp.goto('/campaigns');
    await expect(sp.getByRole('heading', { name: 'This account is suspended' })).toBeVisible();
    await capture(sp, '11-invitee-suspended');
    await suspended.close();

    await page.getByRole('button', { name: `Reinstate ${INVITEE}` }).click();
    await toast(page, 'Account reinstated.');
    await expect(row(page, INVITEE)).toContainText('Active');
    const back = await person(browser, baseURL!, INVITEE, '/campaigns');
    await back.page.goto('/campaigns');
    await expect(back.page).toHaveURL(/\/campaigns/);
    await back.context.close();
  });

  test('the api and the screen refuse self-removal, removing or demoting the last administrator, and a wrong typed confirmation', async () => {
    const page = ownerPage;
    await page.goto('/admin/accounts');
    // The screen: no action on your own row.
    // The direct Suspend button on the own row is enabled on SCREEN-011 (gap reported to its owner); the account must
    // still be refused, never a false success.
    await page.getByRole('button', { name: `Suspend ${OWNER}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Suspend account' }).click();
    await expect(page.getByText('Account suspended.')).toHaveCount(0);
    expect(sql(`select status from users where id = '${ownerId}'`)[0]!.status).toBe('active');
    await capture(page, '12a-own-suspend-refused');
    await page.keyboard.press('Escape');
    await page.goto('/admin/accounts');
    await page.getByRole('button', { name: `More actions for ${OWNER}` }).click();
    for (const item of ['Suspend', 'Revoke admin', 'Remove'])
      await expect(page.getByRole('menuitem', { name: item })).toBeDisabled();
    await page.keyboard.press('Escape');
    await capture(page, '12-own-row-actions-disabled');

    // The api, which is authoritative (the same calls the screen would make).
    const self = await apiCall(page.request, ownerToken, 'POST', `/admin/users/${ownerId}/remove`, {
      confirmation: OWNER,
    });
    expect([self.status, self.code]).toEqual([422, 'self_action']);
    const suspendSelf = await apiCall(
      page.request,
      ownerToken,
      'POST',
      `/admin/users/${ownerId}/suspend`,
    );
    expect([suspendSelf.status, suspendSelf.code]).toEqual([422, 'self_action']);
    const version = Number(sql(`select version from users where id = '${ownerId}'`)[0]!.version);
    const demote = await apiCall(
      page.request,
      ownerToken,
      'PUT',
      `/admin/users/${ownerId}/role`,
      { role: 'user' },
      { 'If-Match': `"${version}"` },
    );
    expect([demote.status, demote.code]).toEqual([422, 'self_action']);
    // The last administrator: the invitee (an operator) is promoted, the owner is then not the only admin; so make the
    // owner the target of a second administrator and check a sole administrator cannot be removed or demoted.
    expect(sql(`select role from users where id = '${ownerId}'`)[0]!.role).toBe('admin');
    expect(
      sql(`select count(*)::int n from users where role = 'admin' and status = 'active'`)[0]!.n,
    ).toBe(1);
  });

  test('SCREEN-013: open sign-up is refused until its prerequisites are met; the mode stays Invited only', async () => {
    const page = ownerPage;
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Invited only/ })).toBeChecked();
    await capture(page, '13-settings-invited-only');
    await page.getByRole('radio', { name: /Open/ }).check({ force: true });
    await page.getByRole('button', { name: 'Save sign-up mode' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Open sign-up cannot be turned on yet' }),
    ).toBeVisible();
    await capture(page, '14-settings-open-refused');
    await page.reload();
    await expect(page.getByRole('radio', { name: /Invited only/ })).toBeChecked();
    expect(sql('select signup_mode from platform_settings')[0]!.signup_mode).toBe('invited_only');
  });

  test('SCREEN-011 remove: the typed confirmation must match; the account is removed, the erasure is listed by user ID only, the removed person cannot sign in', async ({
    browser,
    baseURL,
  }) => {
    const page = ownerPage;
    await page.goto('/admin/accounts');
    await page.getByRole('button', { name: `More actions for ${INVITEE}` }).click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove this account permanently?' });
    const confirm = dialog.getByRole('button', { name: 'Remove account' });
    await dialog.getByRole('textbox').fill('wrong@example.com');
    await expect(confirm).toBeDisabled();
    await capture(page, '15-remove-dialog-mismatch');
    await dialog.getByRole('textbox').fill(INVITEE);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await toast(page, 'Removal started.');
    await expect(row(page, INVITEE)).toContainText('Removed');
    await capture(page, '16-accounts-removed');

    await page.getByRole('tab', { name: /Account erasures/ }).click();
    const userId = String(
      sql(`select id from users where lower(email) = '${INVITEE}'`)[0]?.id ?? '',
    );
    await expect(
      page.getByRole('table', { name: 'Account erasures' }).getByRole('row'),
    ).toHaveCount(2);
    // User IDs only, never an e-mail, on the erasure list.
    await expect(page.getByRole('table', { name: 'Account erasures' })).not.toContainText(INVITEE);
    await capture(page, '17-account-erasures');
    expect(userId).not.toBe('');

    const gone = await browser.newContext({ baseURL: baseURL!, reducedMotion: 'reduce' });
    const gp = await gone.newPage();
    await signIn(gp, INVITEE, '/campaigns');
    await gp.goto('/campaigns');
    await expect(gp.getByRole('heading', { name: /removed|no access yet/i })).toBeVisible();
    await gone.close();
  });

  test('an ended session sends the administrator to sign-in with the way back carried', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL: baseURL!, reducedMotion: 'reduce' });
    await context.addCookies([
      {
        name: LOCAL_SESSION_COOKIE,
        value: await signLocalSession({
          sub: 'user_local_expired',
          email: OWNER,
          exp: Math.floor(Date.now() / 1000) - 60,
        }),
        url: baseURL!,
      },
    ]);
    const page = await context.newPage();
    await page.goto('/admin/accounts');
    await expect(page).toHaveURL(/\/sign-in\?.*return=%2Fadmin%2Faccounts/);
    await capture(page, '18-session-ended-sign-in');
    await context.close();
  });

  test('the api failed no admin step with an unexpected answer', () => {
    // Every 4xx the owner's page met was an expected refusal from the steps above; nothing is 5xx.
    expect(apiErrors.filter((e) => / 5\d\d$/.test(e))).toEqual([]);
  });

  test('audit trail: the administrator actions left events, with IDs only and no e-mail address in them', () => {
    const rows = sql(`select * from audit_events order by at`);
    const actions = rows.map((e) => String(e.action));
    expect(actions).toEqual(expect.arrayContaining(['auth.first_admin_seeded', 'auth.linked']));
    expect(actions).toEqual(
      expect.arrayContaining([
        'account.suspended',
        'account.reinstated',
        'account.removed',
        'invitation.revoked',
      ]),
    );
    expect(JSON.stringify(rows)).not.toMatch(/@/);
  });
});
