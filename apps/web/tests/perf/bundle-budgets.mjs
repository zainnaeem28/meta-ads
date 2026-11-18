// Route-group JS and CSS transfer budgets (TASK-119, NFR-02). Reads baselines.frontend.bundleBudgets of
// config/quality-policy.json, measures the gzip size of the first-load chunks and linked stylesheets of every route of the
// built web app (.next), and fails when a route group exceeds its budget or a built route belongs to no budgeted group.
//   node bundle-budgets.mjs [--web DIR] [--out FILE] [--junit FILE] [--print]   (--print: measure only, always exit 0)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = resolve(here, '..', '..');
export const POLICY_FILE = resolve(WEB_DIR, '..', '..', 'config', 'quality-policy.json');

export const loadBudgets = (file = process.env.CI_POLICY ?? POLICY_FILE) => {
  const budgets = JSON.parse(readFileSync(file, 'utf8')).baselines?.frontend?.bundleBudgets;
  if (!budgets?.groups)
    throw new Error(`${file}: baselines.frontend.bundleBudgets.groups is not set`);
  return budgets;
};

const gzipBytes = (file) => gzipSync(readFileSync(file), { level: 9 }).length;

/** The route group of a built page key: "/(operator)/campaigns/page" is "operator", a page outside any group is "root". */
export const groupOf = (pageKey) => /^\/\(([^)]+)\)\//.exec(pageKey)?.[1] ?? 'root';

/** Stylesheets a page links, read from its client reference manifest. */
const cssOf = (webDir, pageKey) => {
  const manifest = join(
    webDir,
    '.next',
    'server',
    'app',
    `${pageKey}_client-reference-manifest.js`,
  );
  if (!existsSync(manifest)) return [];
  const paths = new Set();
  for (const m of readFileSync(manifest, 'utf8').matchAll(/"path":"(static\/[^"]+\.css)"/g))
    paths.add(m[1]);
  return [...paths].map((p) => join(webDir, '.next', p));
};

/** One row per built route: its group and the transfer size (gzip bytes) of its first-load JS and CSS. */
export const measureRoutes = (webDir = WEB_DIR) => {
  const next = join(webDir, '.next');
  const stats = JSON.parse(
    readFileSync(join(next, 'diagnostics', 'route-bundle-stats.json'), 'utf8'),
  );
  const pages = JSON.parse(readFileSync(join(next, 'app-path-routes-manifest.json'), 'utf8'));
  const pageOf = Object.fromEntries(Object.entries(pages).map(([key, route]) => [route, key]));
  return stats.map((entry) => {
    const pageKey = pageOf[entry.route];
    return {
      route: entry.route,
      group: pageKey ? groupOf(pageKey) : 'root',
      jsBytes: entry.firstLoadChunkPaths.reduce((n, p) => n + gzipBytes(join(webDir, p)), 0),
      cssBytes: pageKey ? cssOf(webDir, pageKey).reduce((n, f) => n + gzipBytes(f), 0) : 0,
    };
  });
};

/** Pure check: routes are measured rows, budgets the policy section. Returns per-group rows and the problems found. */
export const evaluateBudgets = (routes, budgets) => {
  const excluded = new Set(budgets.excludeRoutes ?? []);
  const problems = [];
  const groups = Object.entries(budgets.groups).map(([name, limit]) => {
    const own = routes.filter((r) => r.group === name && !excluded.has(r.route));
    const worst = (key) => own.reduce((a, r) => (r[key] > (a?.[key] ?? -1) ? r : a), undefined);
    const js = worst('jsBytes');
    const css = worst('cssBytes');
    if (own.length === 0)
      problems.push(`group ${name}: no built route (policy lists a group the app does not have)`);
    if (js && js.jsBytes > limit.jsKB * 1024)
      problems.push(
        `group ${name}: ${js.route} JS ${(js.jsBytes / 1024).toFixed(1)} KB gzip > ${limit.jsKB} KB`,
      );
    if (css && css.cssBytes > limit.cssKB * 1024)
      problems.push(
        `group ${name}: ${css.route} CSS ${(css.cssBytes / 1024).toFixed(1)} KB gzip > ${limit.cssKB} KB`,
      );
    return { group: name, limit, routes: own.map((r) => r.route), worstJs: js, worstCss: css };
  });
  for (const r of routes)
    if (!excluded.has(r.route) && !(r.group in budgets.groups))
      problems.push(`route ${r.route}: group ${r.group} has no budget in the policy`);
  return { groups, problems };
};

/** The command: returns the exit code. argv is the argument list after the script name. */
export const main = (argv, write = (text) => process.stdout.write(text)) => {
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const routes = measureRoutes(resolve(flag('web') ?? WEB_DIR));
  if (argv.includes('--print')) {
    for (const r of routes)
      write(
        `${r.group}\t${r.route}\tjs ${(r.jsBytes / 1024).toFixed(1)} KB\tcss ${(r.cssBytes / 1024).toFixed(1)} KB\n`,
      );
    return 0;
  }
  const { groups, problems } = evaluateBudgets(routes, loadBudgets());
  const report = {
    tool: 'route-group transfer budgets (gzip)',
    routes,
    groups,
    problems,
    result: problems.length ? 'fail' : 'pass',
  };
  const out = flag('out');
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
  }
  const junit = flag('junit');
  if (junit) {
    mkdirSync(dirname(resolve(junit)), { recursive: true });
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const cases = groups.map((g) => {
      const bad = problems.filter((p) => p.startsWith(`group ${g.group}:`));
      return `<testcase classname="TC-NFR-02 bundle budgets" name="group ${g.group}">${bad.map((b) => `<failure message="${esc(b)}"/>`).join('')}</testcase>`;
    });
    writeFileSync(
      junit,
      `<?xml version="1.0"?><testsuite name="bundle-budgets" tests="${cases.length}" failures="${problems.length}">${cases.join('')}</testsuite>`,
    );
  }
  for (const g of groups)
    write(
      `${problems.some((p) => p.startsWith(`group ${g.group}:`)) ? 'FAIL' : 'PASS'} ${g.group}: JS ${((g.worstJs?.jsBytes ?? 0) / 1024).toFixed(1)}/${g.limit.jsKB} KB, CSS ${((g.worstCss?.cssBytes ?? 0) / 1024).toFixed(1)}/${g.limit.cssKB} KB (gzip)\n`,
    );
  for (const p of problems) write(`  ${p}\n`);
  return problems.length ? 1 : 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
