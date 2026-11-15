// Line and branch coverage for the bash scripts, measured from an xtrace of every real run.
// A line is covered when bash traced it. A branch exists on each line with `||`, `&&` or `if`/`elif`:
// "ran" when the right-hand side or the then-body executed, "skipped" when it did not.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const traceFile = resolve(repoRoot, 'reports/release/trace.log');
export const scriptPaths = [
  'scripts/ci/verify-release-approval.sh',
  'scripts/ci/release-with-recovery.sh',
  'scripts/ci/hosts/stub.sh',
  'scripts/ci/hosts/render.sh',
  'scripts/ci/observe.sh',
];
export const PS4 = 'TRC|${BASH_SOURCE[0]}|${LINENO}|${BASHPID}|${#BASH_LINENO[@]}|';

const structural = /^(fi|done|esac|then|else|do|\{|\}|\)|;;|"|'|EOF)$/;
const functionOpen = /^[A-Za-z_][\w-]*\(\)\s*\{\s*(#.*)?$/;
const branching = /\|\||&&|^(if|elif) /;

interface Entry {
  line: number;
  depth: number;
}

function executableLines(lines: string[]): Set<number> {
  const found = new Set<number>();
  let continued = false;
  lines.forEach((raw, index) => {
    const text = raw.trim();
    const isContinuation = continued;
    continued = text.endsWith('\\');
    if (
      isContinuation ||
      text === '' ||
      text.startsWith('#') ||
      structural.test(text) ||
      functionOpen.test(text)
    )
      return;
    found.add(index + 1);
  });
  return found;
}

function readTrace(): Map<string, Map<string, Entry[]>> {
  const files = new Map<string, Map<string, Entry[]>>();
  if (!existsSync(traceFile)) return files;
  for (const row of readFileSync(traceFile, 'utf8').split('\n')) {
    const m = /^\+*TRC\|([^|]*)\|(\d+)\|(\d+)\|(\d+)\|/.exec(row);
    if (!m) continue;
    const file = m[1]!.replace(`${repoRoot}/`, '');
    const pids = files.get(file) ?? new Map<string, Entry[]>();
    files.set(file, pids);
    const list = pids.get(m[3]!) ?? [];
    pids.set(m[3]!, list);
    list.push({ line: Number(m[2]), depth: Number(m[4]) });
  }
  return files;
}

function fileRecord(path: string, pids: Map<string, Entry[]>): string {
  const lines = readFileSync(resolve(repoRoot, path), 'utf8').split('\n');
  const exec = executableLines(lines);
  const nextExec = (n: number) => {
    for (let i = n + 1; i <= lines.length; i += 1) if (exec.has(i)) return i;
    return -1;
  };
  const hits = new Map<number, number>();
  const ran = new Set<number>();
  const skipped = new Set<number>();
  for (const raw of pids.values()) {
    const list = raw.map((e) => {
      let line = e.line;
      while (line > 0 && !exec.has(line)) line -= 1; // a continuation line belongs to its statement start
      return { ...e, line };
    });
    list.forEach((e) => hits.set(e.line, (hits.get(e.line) ?? 0) + 1));
    const successor = (from: number, depth: number) =>
      list.findIndex((p, i) => i > from && p.depth <= depth);
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i]!;
      const text = lines[e.line - 1]!.trim();
      if (!branching.test(text)) continue;
      const before = list
        .slice(0, i)
        .reverse()
        .find((p) => p.depth <= e.depth);
      if (before && before.line === e.line && before.depth === e.depth) continue; // inside a visit already counted
      if (/^(if|elif) /.test(text) && !/\bfi\b/.test(text)) {
        const next = list[successor(i, e.depth)];
        (next && next.line === nextExec(e.line) ? ran : skipped).add(e.line);
        continue;
      }
      let chain = 1;
      let at = successor(i, e.depth);
      while (at >= 0 && list[at]!.line === e.line && list[at]!.depth === e.depth) {
        chain += 1;
        at = successor(at, e.depth);
      }
      (chain >= 2 ? ran : skipped).add(e.line);
    }
  }
  const branchLines = [...exec].filter((n) => branching.test(lines[n - 1]!.trim()));
  let out = `TN:\nSF:${path}\n`;
  let taken = 0;
  for (const n of branchLines) {
    for (const [id, set] of [
      [0, ran],
      [1, skipped],
    ] as const) {
      const hit = set.has(n);
      taken += hit ? 1 : 0;
      out += `BRDA:${n},0,${id},${hit ? 1 : '-'}\n`;
    }
  }
  const sorted = [...exec].sort((a, b) => a - b);
  for (const n of sorted) out += `DA:${n},${hits.get(n) ?? 0}\n`;
  out += `LF:${sorted.length}\nLH:${sorted.filter((n) => hits.get(n)).length}\n`;
  out += `BRF:${branchLines.length * 2}\nBRH:${taken}\nend_of_record\n`;
  return out;
}

export function buildLcov(): string {
  const trace = readTrace();
  return scriptPaths.map((path) => fileRecord(path, trace.get(path) ?? new Map())).join('');
}

export function writeLcov(): void {
  mkdirSync(resolve(repoRoot, 'reports/release'), { recursive: true });
  writeFileSync(resolve(repoRoot, 'reports/release/lcov.info'), buildLcov());
}
