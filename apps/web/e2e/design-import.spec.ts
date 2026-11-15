import { mkdirSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-066';

test.describe('@TASK-066 design import through the built web app', () => {
  test('serves Inter from its own origin, with no third-party request, and resolves the tokens', async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const requests: string[] = [];
    page.on('request', (req) => requests.push(req.url()));

    await page.goto('/');
    await page.evaluate(() => document.fonts.load('400 16px Inter', 'Shroomap'));

    const foreign = requests.filter((url) => !url.startsWith(origin) && !url.startsWith('data:'));
    expect(foreign).toEqual([]);
    expect(requests.some((url) => /inter-latin-wght-normal.*\.woff2$/.test(url))).toBe(true);

    const state = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const probe = document.createElement('div');
      probe.dataset.portal = 'admin';
      document.body.append(probe);
      const adminPrimary = getComputedStyle(probe).getPropertyValue('--primary').trim();
      return {
        primary: root.getPropertyValue('--primary').trim(),
        adminPrimary,
        background: body.backgroundColor,
        color: body.color,
        family: body.fontFamily,
        interLoaded: document.fonts.check('400 16px Inter', 'Shroomap'),
        faces: [...document.fonts].map((f) => `${f.family}|${f.weight}|${f.status}`),
        main: getComputedStyle(document.querySelector('[data-testid=home]')!).fontSize,
      };
    });
    expect(state.primary).toBe('#4a6f47');
    expect(state.adminPrimary).toBe('#232d38');
    expect(state.background).toBe('rgb(251, 249, 244)');
    expect(state.color).toBe('rgb(35, 45, 56)');
    expect(state.family).toContain('Inter');
    expect(state.interLoaded).toBe(true);
    expect(state.main).toBe('24px');

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-testid=home]',
    });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    expect(fonts.map((f) => [f.familyName, f.isCustomFont])).toEqual([['Inter', true]]);
  });

  test('stylesheet declares the Inter faces with font-display swap', async ({ page }) => {
    await page.goto('/');
    const faces = await page.evaluate(() =>
      [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule)
        .map((rule) => ({
          display: rule.style.getPropertyValue('font-display'),
          weight: rule.style.getPropertyValue('font-weight'),
        })),
    );
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face.display).toBe('swap');
      expect(face.weight).toBe('400 600');
    }
  });

  for (const width of [390, 1440]) {
    test(`has no axe violations at ${width} px`, async ({ page }) => {
      mkdirSync(evidence, { recursive: true });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const results = await new AxeBuilder({ page }).analyze();
      writeFileSync(`${evidence}/axe-${width}.json`, JSON.stringify(results.violations, null, 2));
      expect(results.violations).toEqual([]);
    });
  }

  test('runs beside the built api', async ({ request }) => {
    const res = await request.get(`${process.env.E2E_API_URL}/health/live`);
    expect(res.ok()).toBe(true);
  });

  for (const [name, width, height] of [
    ['390', 390, 844],
    ['1440', 1440, 900],
  ] as const) {
    test(`screenshot at ${name} px`, async ({ page }) => {
      mkdirSync(evidence, { recursive: true });
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${evidence}/home-${name}.png` });
    });
  }
});
