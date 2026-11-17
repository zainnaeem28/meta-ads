import { test } from '@playwright/test';
import { LOCAL_SESSION_COOKIE, signLocalSession } from '../../../src/lib/auth/local-session';

const control = process.env.FLOW03_CONTROL_URL!;
const post = (path: string, body: unknown) => fetch(`${control}${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

test('explore', async ({ page, context, baseURL }) => {
  const seeded = await post('/seed', { email: 'flow03@example.com' });
  await post('/behaviour', { failOnce: [2], qcMismatch: [3] });
  await context.addCookies([{ name: LOCAL_SESSION_COOKIE, value: await signLocalSession({ sub: 'user_local_e2e', email: 'flow03@example.com', exp: Math.floor(Date.now() / 1000) + 3000 }), url: baseURL! }]);
  page.on('response', (r) => { if (r.url().includes(':4303') && r.status() >= 400) r.text().then((t) => console.log(r.status(), r.url(), t.slice(0, 300))); });
  await page.goto(`/campaigns/${seeded.campaign}/brief`);
  await page.getByRole('link', { name: 'Continue to clips' }).first().click();
  await page.waitForURL('**/clips');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/explore-clips-0.png', fullPage: true });
  console.log(await page.locator('main').innerText());
  await page.getByRole('button', { name: 'Generate remaining clips' }).click();
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(4000);
    console.log(i, JSON.stringify((await (await fetch(`${control}/state?campaign=${seeded.campaign}`)).json()).jobs.map((j: any) => [j.position, j.state, j.cause_class, j.qc_state])));
  }
  await page.screenshot({ path: '/tmp/explore-clips-1.png', fullPage: true });
  console.log(await page.locator('main').innerText());
});
