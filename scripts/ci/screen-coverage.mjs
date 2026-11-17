#!/usr/bin/env node
// Screen coverage gate (TASK-118, NFR-06, NFR-07, UI-UX §12, QUALITY-RELEASE-PLAN §6).
//
// Generates the list of every screen x state x viewport from the frame manifest (design/mockups/frames.json) and,
// when present, the screens named in traceability.json, then fails when any entry has no axe result with zero
// critical findings or no approved visual baseline. The same list demands, for each screen group of
// apps/web/tests/a11y/screen-map.json, the UI-UX §12 captures (320 px reflow, 200 % zoom, text spacing at 390 and 1440 px).
//
//   node scripts/ci/screen-coverage.mjs [--traceability <file>] [--out <dir>]
//
// Writes screen-coverage.json (machine readable, feeds QA-REPORT) and screen-coverage.md (the UI/UX per-screen comparison:
// design frame beside the approved baseline) to apps/web/reports/a11y and docs/evidence/TASK-118.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const outDir = resolve(root, arg('--out') ?? 'apps/web/reports/a11y');
const evidenceDir = join(root, 'docs/evidence');
const e2eBaselines = join(root, 'apps/web/e2e/__baselines__/chromium');
const a11yBaselines = join(root, 'apps/web/tests/a11y/__baselines__/chromium');
const FRAMES = join(root, 'design/mockups/frames.json');
const MAP = join(root, 'apps/web/tests/a11y/screen-map.json');
const WCAG_VARIANTS = ['reflow-320', 'zoom-640', 'spacing-390', 'spacing-1440'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const rel = (file) => relative(root, file);

/** A baseline is approved when it is committed, is a real PNG and is not a near-empty image. */
function baselineProblem(file) {
  if (!existsSync(file)) return 'no approved baseline';
  const bytes = readFileSync(file);
  if (!bytes.subarray(0, 8).equals(PNG)) return 'baseline is not a PNG';
  if (bytes.length < 1500) return 'baseline is empty or text-only (under 1.5 kB)';
  return null;
}

/** An axe result is a committed array of violations; any critical or serious one fails. */
function axeProblem(file) {
  if (!existsSync(file)) return 'no axe result';
  let violations;
  try {
    violations = readJson(file);
  } catch {
    return 'axe result is not JSON';
  }
  if (!Array.isArray(violations)) return 'axe result is not a violations array';
  const bad = violations.filter((v) => ['critical', 'serious'].includes(v.impact));
  return bad.length ? `axe ${bad.map((v) => `${v.impact} ${v.id}`).join(', ')}` : null;
}

const baselinePath = (name, width) => {
  const [place, base] = name.startsWith('a11y:')
    ? [a11yBaselines, name.slice(5)]
    : [e2eBaselines, name];
  return join(place, `${base}-${width}.png`);
};

const frames = readJson(FRAMES);
const map = readJson(MAP);
const notes = [];

// The inventory: every screen frame of the manifest; traceability.json, when present, may only add screens.
const trace =
  arg('--traceability') ??
  ['docs/traceability.json', 'traceability.json'].map((p) => join(root, p)).find(existsSync);
const screens = new Map(frames.filter((f) => f.id.startsWith('SCREEN-')).map((f) => [f.id, f]));
if (trace && existsSync(trace)) {
  const t = readJson(trace);
  const ids = JSON.stringify(t).match(/SCREEN-\d{3}/g) ?? [];
  for (const id of new Set(ids)) {
    if (!screens.has(id)) screens.set(id, { id, states: [], widths: [] });
  }
  notes.push(`traceability: ${rel(trace)}`);
} else {
  notes.push(
    'traceability.json is not in the repository; the inventory comes from the frame manifest alone',
  );
}
notes.push(
  `component sheets (${frames
    .filter((f) => !f.id.startsWith('SCREEN-'))
    .map((f) => f.id)
    .join(', ')}) are covered by the gallery baselines (TASK-081), not by this screen list`,
);

const rows = [];
const failures = [];

for (const [id, frame] of [...screens].sort(([a], [b]) => a.localeCompare(b))) {
  const entry = map.screens[id];
  if (!entry) {
    failures.push(`${id}: no entry in screen-map.json`);
    continue;
  }
  if (frame.states.length === 0) failures.push(`${id}: no frame in the manifest`);
  for (const state of frame.states) {
    for (const width of frame.widths) {
      const override = entry.states[state];
      const baseline = override
        ? baselinePath(override.baseline, width)
        : (entry.sources
            .map((s) => baselinePath(`${s.baseline}-${state}`, width))
            .find(existsSync) ?? baselinePath(`${entry.sources[0].baseline}-${state}`, width));
      const axe = override
        ? join(evidenceDir, override.axe.replace('{w}', width))
        : (entry.sources
            .map((s) => join(evidenceDir, s.evidence, 'axe', `chromium-${state}-${width}.json`))
            .find(existsSync) ??
          join(evidenceDir, entry.sources[0].evidence, 'axe', `chromium-${state}-${width}.json`));
      const problems = [baselineProblem(baseline), axeProblem(axe)].filter(Boolean);
      const frameFile = join(root, 'design/mockups/png', `${id}--${state}--${width}.png`);
      rows.push({
        kind: 'state',
        screen: id,
        state,
        width,
        frame: existsSync(frameFile) ? rel(frameFile) : null,
        baseline: rel(baseline),
        axe: rel(axe),
        ok: problems.length === 0,
        problems,
      });
      for (const p of problems) failures.push(`${id} ${state} @${width}: ${p}`);
    }
  }
}

// UI-UX §12 captures per screen group: reflow, zoom and text spacing, each with a baseline and an axe result.
const grouped = new Set();
for (const [group, ids] of Object.entries(map.groups)) {
  for (const id of ids) {
    grouped.add(id);
    if (!screens.has(id)) failures.push(`group ${group}: ${id} is not in the inventory`);
  }
  for (const variant of WCAG_VARIANTS) {
    const baseline = join(a11yBaselines, `a11y-${group}-${variant}.png`);
    const axe = join(evidenceDir, 'TASK-118/axe', `chromium-wcag-${group}-${variant}.json`);
    const problems = [baselineProblem(baseline), axeProblem(axe)].filter(Boolean);
    rows.push({
      kind: 'wcag',
      group,
      screens: ids,
      variant,
      baseline: rel(baseline),
      axe: rel(axe),
      ok: problems.length === 0,
      problems,
    });
    for (const p of problems) failures.push(`group ${group} ${variant}: ${p}`);
  }
}
for (const id of screens.keys())
  if (!grouped.has(id))
    failures.push(`${id}: in no screen group, so no reflow, zoom or text-spacing capture`);

const states = rows.filter((r) => r.kind === 'state');
const wcag = rows.filter((r) => r.kind === 'wcag');
const summary = {
  generatedFrom: [rel(FRAMES), rel(MAP), ...(trace && existsSync(trace) ? [rel(trace)] : [])],
  screens: screens.size,
  statesXViewports: states.length,
  statesCovered: states.filter((r) => r.ok).length,
  wcagCaptures: wcag.length,
  wcagCovered: wcag.filter((r) => r.ok).length,
  failures: failures.length,
  notes,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'screen-coverage.json'),
  `${JSON.stringify({ summary, rows, failures }, null, 2)}\n`,
);

const md = [
  '# Screen coverage (generated by scripts/ci/screen-coverage.mjs)',
  '',
  `Result: **${failures.length ? 'FAIL' : 'PASS'}** — ${summary.statesCovered}/${summary.statesXViewports} screen x state x viewport entries have an axe result (no critical or serious) and an approved baseline; ${summary.wcagCovered}/${summary.wcagCaptures} reflow, zoom and text-spacing captures present.`,
  '',
  ...notes.map((n) => `- ${n}`),
  '',
  '## Screen x state x viewport (design frame beside the approved baseline, for the UI/UX comparison)',
  '',
  '| Screen | State | Width | Design frame | Approved baseline | Axe | Result |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...states.map(
    (r) =>
      `| ${r.screen} | ${r.state} | ${r.width} | ${r.frame ? `\`${r.frame}\`` : 'none'} | \`${r.baseline}\` | \`${r.axe}\` | ${r.ok ? 'pass' : `FAIL: ${r.problems.join('; ')}`} |`,
  ),
  '',
  '## UI-UX §12 captures per screen group',
  '',
  '| Group | Screens | Capture | Baseline | Axe | Result |',
  '| --- | --- | --- | --- | --- | --- |',
  ...wcag.map(
    (r) =>
      `| ${r.group} | ${r.screens.join(', ')} | ${r.variant} | \`${r.baseline}\` | \`${r.axe}\` | ${r.ok ? 'pass' : `FAIL: ${r.problems.join('; ')}`} |`,
  ),
  '',
  ...(failures.length ? ['## Failures', '', ...failures.map((f) => `- ${f}`), ''] : []),
].join('\n');
writeFileSync(join(outDir, 'screen-coverage.md'), md);
if (!arg('--out')) {
  mkdirSync(join(evidenceDir, 'TASK-118'), { recursive: true });
  writeFileSync(join(evidenceDir, 'TASK-118/screen-coverage.md'), md);
}

console.log(
  `screen-coverage: ${summary.screens} screens, ${summary.statesCovered}/${summary.statesXViewports} state x viewport entries, ` +
    `${summary.wcagCovered}/${summary.wcagCaptures} group captures, ${failures.length} failure(s)`,
);
for (const f of failures) console.error(`  MISSING ${f}`);
process.exit(failures.length ? 1 : 0);
