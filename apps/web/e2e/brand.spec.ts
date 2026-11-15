import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../tests/support/axe';
import { VIEWPORTS } from '../tests/support/visual';

const evidence = process.env.EVIDENCE_DIR ?? '../../docs/evidence/TASK-068';
const ORIGIN = process.env.E2E_WEB_ORIGIN ?? `http://127.0.0.1:${process.env.WEB_PORT ?? 3100}`;

const pngSize = (body: Buffer) => ({ width: body.readUInt32BE(16), height: body.readUInt32BE(20) });

async function headTags(page: Page) {
  return page.evaluate(() => {
    const attr = (sel: string, name: string) =>
      document.querySelector(sel)?.getAttribute(name) ?? null;
    return {
      title: document.title,
      robots: attr('meta[name=robots]', 'content'),
      themeColor: attr('meta[name=theme-color]', 'content'),
      manifest: attr('link[rel=manifest]', 'href'),
      ogTitle: attr('meta[property="og:title"]', 'content'),
      ogImage: attr('meta[property="og:image"]', 'content'),
      ogImageWidth: attr('meta[property="og:image:width"]', 'content'),
      ogImageHeight: attr('meta[property="og:image:height"]', 'content'),
      ogType: attr('meta[property="og:type"]', 'content'),
      ogSite: attr('meta[property="og:site_name"]', 'content'),
      twitterCard: attr('meta[name="twitter:card"]', 'content'),
      twitterImage: attr('meta[name="twitter:image"]', 'content'),
      icons: [...document.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon]')].map(
        (l) => ({
          rel: l.getAttribute('rel'),
          href: l.getAttribute('href'),
          sizes: l.getAttribute('sizes'),
          type: l.getAttribute('type'),
        }),
      ),
    };
  });
}

test.describe('@TASK-068 @harness brand metadata through the built web app', () => {
  test('page title pattern, theme colour, robots and manifest link', async ({ page }) => {
    await page.goto('/');
    const home = await headTags(page);
    expect(home.title).toBe('ShrooMap AI UGC Ad Director');
    expect(home.robots).toMatch(/noindex/);
    expect(home.themeColor).toBe('#4A6F47');
    expect(home.manifest).toBe('/site.webmanifest');
    await page.goto('/gallery');
    expect((await headTags(page)).title).toBe('Component gallery · ShrooMap');
  });

  test('Open Graph and Twitter tags use absolute URLs from the configured origin', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    const tags = await headTags(page);
    expect(tags.ogImage).toBe(`${ORIGIN}/social-preview.png`);
    expect(tags.twitterImage).toBe(`${ORIGIN}/social-preview.png`);
    expect(tags.ogType).toBe('website');
    expect(tags.ogSite).toBe('ShrooMap');
    expect(tags.ogTitle).toBe('ShrooMap AI UGC Ad Director');
    expect(tags.ogImageWidth).toBe('1200');
    expect(tags.ogImageHeight).toBe('630');
    expect(tags.twitterCard).toBe('summary_large_image');
    const res = await request.get(tags.ogImage as string);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(pngSize(await res.body())).toEqual({ width: 1200, height: 630 });
  });

  test('every declared icon and the manifest resolve at their declared size and type', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    const { icons } = await headTags(page);
    expect(icons.map((i) => i.href).sort()).toEqual(
      [
        '/apple-touch-icon.png',
        '/favicon-16.png',
        '/favicon-32.png',
        '/favicon-48.png',
        '/favicon.ico',
        '/favicon.svg',
      ].sort(),
    );
    for (const icon of icons) {
      const res = await request.get(icon.href as string);
      expect(res.status(), icon.href as string).toBe(200);
      if (icon.type === 'image/png') {
        const side = Number(icon.sizes?.split('x')[0]);
        expect(pngSize(await res.body()), icon.href as string).toEqual({
          width: side,
          height: side,
        });
      }
    }
    const manifestRes = await request.get('/site.webmanifest');
    expect(manifestRes.status()).toBe(200);
    const manifest = await manifestRes.json();
    expect(manifest.short_name).toBe('ShrooMap');
    for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
      const res = await request.get(icon.src);
      expect(res.status(), icon.src).toBe(200);
      expect(res.headers()['content-type']).toBe(icon.type);
      const side = Number(icon.sizes.split('x')[0]);
      expect(pngSize(await res.body())).toEqual({ width: side, height: side });
    }
  });

  test('maskable icon artwork stays inside the 80 % safe zone and the tab icon renders', async ({
    page,
  }) => {
    await page.goto('/');
    const farthest = await page.evaluate(async () => {
      const img = new Image();
      img.src = '/icon-maskable-512.png';
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
      const bg = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
      let far = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const diff =
            Math.abs((data[i] ?? 0) - bg[0]!) +
            Math.abs((data[i + 1] ?? 0) - bg[1]!) +
            Math.abs((data[i + 2] ?? 0) - bg[2]!);
          if (diff > 12) far = Math.max(far, Math.hypot(x - width / 2, y - height / 2));
        }
      }
      return { far, radius: width / 2 };
    });
    // The safe zone is the circle of 40 % of the side (80 % diameter).
    expect(farthest.far).toBeLessThanOrEqual(farthest.radius * 0.8);
    const favicon = await page.evaluate(async () => {
      const img = new Image();
      img.src = '/favicon.svg';
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    });
    expect(favicon[0]).toBeGreaterThan(0);
  });
});

test.describe('@TASK-068 @harness Logo through the built web app', () => {
  test('the lockup is named ShrooMap, vector only, and the header link is "ShrooMap home"', async ({
    page,
  }) => {
    await page.goto('/gallery');
    const lockup = page.locator('[data-case="light-lockup-160"]');
    await expect(lockup).toHaveAttribute('role', 'img');
    await expect(lockup).toHaveAttribute('aria-label', 'ShrooMap');
    await expect(page.getByRole('img', { name: 'ShrooMap', exact: true }).first()).toBeVisible();
    expect(await page.locator('[data-testid="brand-gallery"] img').count()).toBe(0);

    const link = page.getByTestId('brand-header-light');
    await expect(link).toHaveAccessibleName('ShrooMap home');
    await expect(link).toHaveAttribute('href', '/');
    await expect(link.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    const heights = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="brand-header-light"] svg') as SVGElement;
      return el.getBoundingClientRect().height;
    });
    expect(heights).toBeGreaterThan(0);
  });

  test('the variant follows the surface and meets the minimum sizes', async ({ page }) => {
    await page.goto('/gallery');
    await expect(page.locator('[data-testid="brand-surface-card"] svg')).toHaveAttribute(
      'data-tone',
      'light',
    );
    await expect(page.locator('[data-testid="brand-surface-inverse"] svg')).toHaveAttribute(
      'data-tone',
      'dark',
    );
    const lockupWidth = await page
      .locator('[data-case="light-lockup-120"]')
      .evaluate((el) => parseFloat(getComputedStyle(el).width));
    expect(lockupWidth).toBeGreaterThanOrEqual(120);
    const mark = await page
      .locator('[data-case="light-mark-24"]')
      .evaluate((el) => parseFloat(getComputedStyle(el).width));
    expect(mark).toBeGreaterThanOrEqual(24);
  });

  test('header is 30 px high on desktop and 26 px on phone', async ({ page }) => {
    for (const [width, height, expected] of [
      [1440, 900, 30],
      [390, 844, 26],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      const h = await page.locator('[data-testid="brand-header-light"] svg').evaluate((el) => {
        const cs = getComputedStyle(el);
        return parseFloat(cs.height) - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      });
      expect(h).toBeCloseTo(expected - 12, 0);
    }
  });
});

test.describe('@TASK-068 crisp at 1x and 2x and visual baselines', () => {
  for (const scale of [1, 2]) {
    test(`lockup renders at device scale factor ${scale} with identical geometry`, async ({
      browser,
    }, info) => {
      const context = await browser.newContext({ deviceScaleFactor: scale });
      const page = await context.newPage();
      await page.goto('/gallery');
      const target = page.locator('[data-case="light-lockup-240"]');
      const box = await target.boundingBox();
      const shot = await target.screenshot();
      // A fractional box is captured on whole device pixels (at most one pixel more on each side).
      expect(Math.abs(pngSize(shot).width - (box?.width ?? 0) * scale)).toBeLessThanOrEqual(2);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await target.screenshot({
        path: `${evidence}/screenshots/lockup-light-240-${scale}x-${info.project.name}.png`,
      });
      await context.close();
    });
  }

  test('1x and 2x captures differ only by resolution', async ({ browser }) => {
    const sizes: Record<number, { w: number; h: number; mean: number }> = {};
    for (const scale of [1, 2]) {
      const context = await browser.newContext({ deviceScaleFactor: scale });
      const page = await context.newPage();
      await page.goto('/gallery');
      // Resample the capture to a common 240 x 50.4 grid in the page and compare means.
      const shot = (await page.locator('[data-case="light-lockup-240"]').screenshot()).toString(
        'base64',
      );
      sizes[scale] = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 240;
        c.height = 60;
        const ctx = c.getContext('2d') as CanvasRenderingContext2D;
        ctx.drawImage(img, 0, 0, 240, 60);
        const d = ctx.getImageData(0, 0, 240, 60).data;
        let sum = 0;
        for (const v of d) sum += v;
        return { w: img.width, h: img.height, mean: sum / d.length };
      }, shot);
      await context.close();
    }
    expect(sizes[2]!.w).toBe(sizes[1]!.w * 2);
    expect(sizes[2]!.h).toBe(sizes[1]!.h * 2);
    expect(Math.abs(sizes[2]!.mean - sizes[1]!.mean)).toBeLessThan(2);
  });

  for (const tone of ['light', 'dark', 'mono-ink', 'mono-cream']) {
    test(`${tone} variant at every size matches its baseline`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/gallery');
      const row = page.locator(`[data-artwork="${tone}"]`);
      await expect(row).toHaveScreenshot(`brand-${tone}.png`);
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await row.screenshot({
        path: `${evidence}/screenshots/brand-${tone}-${info.project.name}.png`,
      });
    });
  }

  for (const { name, width, height } of VIEWPORTS.filter((v) => v.name !== '768')) {
    test(`header lockup on light and inverse surfaces matches its baseline at ${name} px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      for (const surface of ['card', 'inverse']) {
        const box = page.locator(`[data-testid="brand-surface-${surface}"]`);
        await expect(box).toHaveScreenshot(`brand-header-${surface}-${name}.png`);
      }
      mkdirSync(`${evidence}/screenshots`, { recursive: true });
      await page.screenshot({
        path: `${evidence}/screenshots/brand-gallery-${name}-${info.project.name}.png`,
        fullPage: true,
      });
    });

    test(`brand gallery has no axe violations at ${name} px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/gallery');
      await expectNoAxeViolations(
        page,
        `${evidence}/axe/${info.project.name}-brand-${name}.json`,
        '#CMP-001',
      );
    });
  }

  test('the brand gallery section is part of the gallery page', async ({ page }) => {
    await page.goto('/gallery');
    await expect(page.locator('#CMP-001')).toBeVisible();
  });
});

test.describe('@TASK-068 @brand-device home-screen and device emulation', () => {
  test('manifest, apple-touch-icon and theme colour are served on a device profile', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    const tags = await headTags(page);
    expect(tags.themeColor).toBe('#4A6F47');
    expect(tags.icons.some((i) => i.rel === 'apple-touch-icon' && i.sizes === '180x180')).toBe(
      true,
    );
    expect((await request.get('/apple-touch-icon.png')).ok()).toBe(true);
    expect((await request.get('/site.webmanifest')).ok()).toBe(true);
  });
});
