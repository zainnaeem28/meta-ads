// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BRAND, Logo, LogoLink, pageTitle, toneForSurface } from './index';

const svgDir = fileURLToPath(new URL('../../../../../design/brand/svg/', import.meta.url));
const owner = (file: string) => readFileSync(`${svgDir}${file}.svg`, 'utf8');
const pathsOf = (svg: string) =>
  [...svg.matchAll(/<path fill="(#\w+)"[^>]* d="([^"]+)"/g)].map((m) => [
    m[1]?.toUpperCase(),
    m[2],
  ]);
const renderedPaths = (html: string) =>
  [...html.matchAll(/<path fill="(#\w+)"[^>]* d="([^"]+)"/g)].map((m) => [
    m[1]?.toUpperCase(),
    m[2],
  ]);

describe('CMP-001 Logo', () => {
  it.each([
    ['light', 'shroomap-logo-light', 'shroomap-mark'],
    ['dark', 'shroomap-logo-dark', 'shroomap-mark-on-dark'],
    ['mono-ink', 'shroomap-logo-mono-ink', 'shroomap-mark-mono-ink'],
    ['mono-cream', 'shroomap-logo-mono-cream', 'shroomap-mark-mono-cream'],
  ] as const)('%s renders the owner artwork unchanged', (tone, lockup, mark) => {
    expect(renderedPaths(renderToStaticMarkup(<Logo tone={tone} />))).toEqual(
      pathsOf(owner(lockup)),
    );
    expect(renderedPaths(renderToStaticMarkup(<Logo tone={tone} form="mark" />))).toEqual(
      pathsOf(owner(mark)),
    );
  });

  it('uses the lockup and mark viewBoxes of the owner files', () => {
    expect(renderToStaticMarkup(<Logo />)).toContain('viewBox="55 47.375 895 188"');
    expect(renderToStaticMarkup(<Logo form="mark" />)).toContain('viewBox="55 47.375 188 188"');
  });

  it('picks light artwork on background, card and muted and dark on the inverse surface', () => {
    for (const surface of ['background', 'card', 'muted'] as const) {
      expect(toneForSurface(surface)).toBe('light');
    }
    expect(toneForSurface('inverse')).toBe('dark');
    expect(renderToStaticMarkup(<Logo surface="inverse" />)).toContain('data-tone="dark"');
    expect(renderToStaticMarkup(<Logo />)).toContain('data-tone="light"');
    expect(renderToStaticMarkup(<Logo surface="inverse" tone="mono-cream" />)).toContain(
      'data-tone="mono-cream"',
    );
  });

  it('is named "ShrooMap" and decorative with an empty alt', () => {
    const named = renderToStaticMarkup(<Logo />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="ShrooMap"');
    const decorative = renderToStaticMarkup(<Logo alt="" />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('aria-label');
    expect(decorative).not.toContain('role=');
  });

  it('renders at least 120 px wide lockups and 24 px marks with 25 % clear space', () => {
    const lockup = renderToStaticMarkup(<Logo size={120} />);
    expect(lockup).toContain('width:120px'); // token-lint-ignore
    expect(lockup).toMatch(/padding:6\.\d+px/);
    const mark = renderToStaticMarkup(<Logo form="mark" size={24} />);
    expect(mark).toContain('width:24px;height:24px;padding:6px'); // token-lint-ignore
    expect(renderToStaticMarkup(<Logo form="mark" size={24} clearSpace={false} />)).not.toContain(
      'padding',
    );
  });

  it('is vector only: no raster image element', () => {
    expect(renderToStaticMarkup(<Logo />)).not.toContain('<img');
  });
});

describe('CMP-001 LogoLink', () => {
  it('is a link named "ShrooMap home" with a decorative header-size lockup', () => {
    const html = renderToStaticMarkup(<LogoLink />);
    expect(html).toContain('href="/"');
    expect(html).toContain('aria-label="ShrooMap home"');
    expect(html).toContain('h-6.5 sm:h-7.5');
    expect(html).toContain('min-h-11 min-w-11');
    expect(html).toContain('aria-hidden="true"');
  });

  it('passes the surface through to the lockup', () => {
    expect(renderToStaticMarkup(<LogoLink logo={{ surface: 'inverse' }} />)).toContain(
      'data-tone="dark"',
    );
  });
});

describe('page metadata helpers', () => {
  it('builds "Page · ShrooMap" titles', () => {
    expect(pageTitle('Projects')).toBe('Projects · ShrooMap');
    expect(pageTitle()).toBe('ShrooMap AI UGC Ad Director');
    expect(BRAND.themeColor).toBe('#4A6F47'); // token-lint-ignore
    expect(BRAND.backgroundColor).toBe('#FBF9F4'); // token-lint-ignore
  });
});
