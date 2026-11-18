import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { accountA, campaignIds, seedCampaigns, signIn, stack } from './stack';

// NFR-02 layout stability (UI-UX §5.1): CLS of a cold load on the phone profile of the web-vitals baseline (4x CPU, 150 ms
// RTT, 1.6 Mbps) for the three screens that had shifts, with one, two and "more than a page" digit counts and with the
// provider-key state `missing` (the baseline accounts have no key), plus the font swap alone (static sign-in page).
const CLS_CEILING = 0.1;
const FONT_SWAP_CEILING = 0.01;
const measured: Record<string, number> = {};

const observer = `
  window.__cls = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
  }).observe({ type: 'layout-shift', buffered: true });
`;

async function coldCls(
  browser: Browser,
  account: ReturnType<typeof accountA>,
  path: string,
): Promise<number> {
  const context = await browser.newContext({
    baseURL: stack().webUrl,
    viewport: { width: 412, height: 823 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
  });
  try {
    await signIn(context, account);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1638.4 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await page.addInitScript(observer);
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    return page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  } finally {
    await context.close();
  }
}

test.describe('@fe-perf-budgets layout stability (NFR-02, UI-UX §5.1)', () => {
  test.afterAll(() => {
    const dir = resolve(__dirname, '../../../', process.env.REPORT_DIR ?? 'reports/perf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'layout-shift.json'), JSON.stringify(measured, null, 2));
  });

  test('the font swap alone moves nothing (static sign-in page)', async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: stack().webUrl,
      viewport: { width: 412, height: 823 },
      isMobile: true,
    });
    const page = await context.newPage();
    await page.addInitScript(observer);
    await page.goto('/sign-in', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    await context.close();
    measured['sign-in font swap'] = cls;
    expect(cls).toBeLessThanOrEqual(FONT_SWAP_CEILING);
  });

  test('history: one-digit counts, then two-digit and "more than a page" counts, key missing', async ({
    browser,
  }) => {
    const a = accountA();
    measured['history, 5 campaigns, key missing'] = await coldCls(browser, a, '/campaigns');
    await seedCampaigns(a, 12, 'Layout check');
    measured['history, 17 campaigns (2 digits), key missing'] = await coldCls(
      browser,
      a,
      '/campaigns',
    );
    await seedCampaigns(a, 60, 'Layout check more');
    measured['history, 77 campaigns (counts above the page limit), key missing'] = await coldCls(
      browser,
      a,
      '/campaigns',
    );
    measured['history, drafts tab'] = await coldCls(browser, a, '/campaigns?tab=drafts');
    for (const [name, value] of Object.entries(measured).filter(([k]) => k.startsWith('history')))
      expect(value, name).toBeLessThanOrEqual(CLS_CEILING);
  });

  test('brief review and intake: key missing, cold load', async ({ browser }) => {
    const a = accountA();
    const [id] = await campaignIds(a);
    measured['brief review, key missing'] = await coldCls(browser, a, `/campaigns/${id}/brief`);
    measured['intake wizard, key missing'] = await coldCls(browser, a, '/campaigns/new');
    measured['clips status, key missing'] = await coldCls(browser, a, `/campaigns/${id}/clips`);
    measured['review and download, key missing'] = await coldCls(
      browser,
      a,
      `/campaigns/${id}/final`,
    );
    for (const name of [
      'brief review, key missing',
      'intake wizard, key missing',
      'clips status, key missing',
      'review and download, key missing',
    ])
      expect(measured[name]!, name).toBeLessThanOrEqual(CLS_CEILING);
  });
});
