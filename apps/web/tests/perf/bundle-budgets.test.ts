import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPerfPolicy, VITALS_CEILING } from '../../perf.config';
// @ts-expect-error plain ES module shared with the CLI
import { evaluateBudgets, groupOf, loadBudgets, main, measureRoutes } from './bundle-budgets.mjs';

const budgets = {
  excludeRoutes: ['/gallery'],
  groups: { root: { jsKB: 10, cssKB: 1 }, operator: { jsKB: 20, cssKB: 1 } },
};
const row = (route: string, group: string, jsKB: number, cssKB = 0.5) => ({
  route,
  group,
  jsBytes: jsKB * 1024,
  cssBytes: cssKB * 1024,
});

describe('route-group budgets (TC-NFR-02)', () => {
  it('passes routes at or under their group limits', () => {
    const { problems } = evaluateBudgets([row('/', 'root', 10), row('/campaigns', 'operator', 19)], budgets);
    expect(problems).toEqual([]);
  });

  it('fails the group whose route exceeds its JS or CSS limit, naming the route', () => {
    const { problems } = evaluateBudgets(
      [row('/', 'root', 9), row('/campaigns', 'operator', 21), row('/campaigns/new', 'operator', 5, 1.5)],
      budgets,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('/campaigns JS 21.0 KB gzip > 20 KB');
    expect(problems[1]).toContain('/campaigns/new CSS 1.5 KB gzip > 1 KB');
  });

  it('fails a built route of a group the policy does not budget, and a budgeted group with no route', () => {
    const { problems } = evaluateBudgets([row('/x', 'newgroup', 1), row('/', 'root', 1)], budgets);
    expect(problems.some((p) => p.includes('group newgroup has no budget'))).toBe(true);
    expect(problems.some((p) => p.includes('group operator: no built route'))).toBe(true);
  });

  it('ignores the excluded test-only routes', () => {
    const { problems } = evaluateBudgets(
      [row('/', 'root', 1), row('/campaigns', 'operator', 1), row('/gallery', 'root', 500)],
      budgets,
    );
    expect(problems).toEqual([]);
  });

  it('reads the route group from the page key', () => {
    expect(groupOf('/(operator)/campaigns/page')).toBe('operator');
    expect(groupOf('/(admin)/admin/usage/page')).toBe('admin');
    expect(groupOf('/page')).toBe('root');
  });

  it('measures the gzip size of the first-load chunks and linked stylesheets of a built app', () => {
    const web = mkdtempSync(join(tmpdir(), 'perf-'));
    afterAll(() => rmSync(web, { recursive: true, force: true }));
    const chunk = 'console.log("x");\n'.repeat(500);
    mkdirSync(join(web, '.next/diagnostics'), { recursive: true });
    mkdirSync(join(web, '.next/static/chunks'), { recursive: true });
    mkdirSync(join(web, '.next/server/app/(operator)/campaigns'), { recursive: true });
    writeFileSync(join(web, '.next/static/chunks/a.js'), chunk);
    writeFileSync(join(web, '.next/static/chunks/a.css'), 'a{color:red}'.repeat(200));
    writeFileSync(
      join(web, '.next/diagnostics/route-bundle-stats.json'),
      JSON.stringify([
        { route: '/campaigns', firstLoadChunkPaths: ['.next/static/chunks/a.js'] },
        { route: '/orphan', firstLoadChunkPaths: ['.next/static/chunks/a.js'] },
      ]),
    );
    writeFileSync(
      join(web, '.next/app-path-routes-manifest.json'),
      JSON.stringify({ '/(operator)/campaigns/page': '/campaigns' }),
    );
    writeFileSync(
      join(web, '.next/server/app/(operator)/campaigns/page_client-reference-manifest.js'),
      '{"entryCSSFiles":{"x":[{"path":"static/chunks/a.css","inlined":false}]}}',
    );
    const [campaigns, orphan] = measureRoutes(web);
    expect(campaigns).toMatchObject({ route: '/campaigns', group: 'operator' });
    expect(campaigns.jsBytes).toBe(gzipSync(chunk, { level: 9 }).length);
    expect(campaigns.cssBytes).toBeGreaterThan(0);
    expect(orphan).toMatchObject({ group: 'root', cssBytes: 0 });
  });

  it('rejects a policy without budgets', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'perf-')), 'p.json');
    writeFileSync(file, JSON.stringify({ baselines: { frontend: {} } }));
    expect(() => loadBudgets(file)).toThrow(/bundleBudgets/);
  });
});

describe('the command', () => {
  const build = (jsRepeat: number) => {
    const root = mkdtempSync(join(tmpdir(), 'perf-'));
    const web = join(root, 'web');
    mkdirSync(join(web, '.next/diagnostics'), { recursive: true });
    mkdirSync(join(web, '.next/static/chunks'), { recursive: true });
    // Incompressible content so the gzip size follows the length.
    let seed = 7;
    const noise = Array.from({ length: jsRepeat }, () => ((seed = (seed * 48271) % 2147483647) % 36).toString(36)).join('');
    writeFileSync(join(web, '.next/static/chunks/a.js'), noise);
    writeFileSync(
      join(web, '.next/diagnostics/route-bundle-stats.json'),
      JSON.stringify([{ route: '/', firstLoadChunkPaths: ['.next/static/chunks/a.js'] }]),
    );
    writeFileSync(join(web, '.next/app-path-routes-manifest.json'), JSON.stringify({ '/page': '/' }));
    const policy = join(root, 'policy.json');
    writeFileSync(
      policy,
      JSON.stringify({ baselines: { frontend: { bundleBudgets: { groups: { root: { jsKB: 4, cssKB: 1 } } } } } }),
    );
    return { root, web, policy };
  };

  it('exits 0 under the budget and 1 over it, and writes the json and junit reports', () => {
    const lines: string[] = [];
    const ok = build(2000);
    process.env.CI_POLICY = ok.policy;
    const out = join(ok.root, 'r', 'budgets.json');
    const junit = join(ok.root, 'r', 'junit.xml');
    expect(main(['--web', ok.web, '--out', out, '--junit', junit], (t: string) => lines.push(t))).toBe(0);
    expect(lines.join('')).toContain('PASS root');
    expect(readFileSync(out, 'utf8')).toContain('"result": "pass"');
    expect(readFileSync(junit, 'utf8')).toContain('failures="0"');

    const big = build(12000);
    process.env.CI_POLICY = big.policy;
    lines.length = 0;
    expect(main(['--web', big.web, '--junit', join(big.root, 'j.xml')], (t: string) => lines.push(t))).toBe(1);
    expect(lines.join('')).toContain('FAIL root');
    expect(readFileSync(join(big.root, 'j.xml'), 'utf8')).toContain('<failure');
    delete process.env.CI_POLICY;
  });

  it('prints the measurements without a policy', () => {
    const lines: string[] = [];
    expect(main(['--web', build(100).web, '--print'], (t: string) => lines.push(t))).toBe(0);
    expect(lines.join('')).toMatch(/^root\t\/\tjs /);
  });
});

describe('the recorded policy', () => {
  const policy = loadPerfPolicy();

  it('never loosens LCP 2.5 s, INP 200 ms, CLS 0.1', () => {
    expect(policy.lcpMs).toBeLessThanOrEqual(VITALS_CEILING.lcpMs);
    expect(policy.inpMs).toBeLessThanOrEqual(VITALS_CEILING.inpMs);
    expect(policy.cls).toBeLessThanOrEqual(VITALS_CEILING.cls);
  });

  it('budgets every route group of the app with positive limits, five samples in both profiles', () => {
    expect(Object.keys(policy.bundleBudgets.groups).sort()).toEqual(['admin', 'auth', 'operator', 'root']);
    for (const limit of Object.values(policy.bundleBudgets.groups)) {
      expect(limit.jsKB).toBeGreaterThan(0);
      expect(limit.cssKB).toBeGreaterThan(0);
    }
    expect(policy.samplesPerRoute).toBeGreaterThanOrEqual(5);
    expect(policy.profiles).toEqual(['mobile', 'desktop']);
    expect(policy.routes).toHaveLength(8);
  });
});
