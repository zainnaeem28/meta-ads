#!/usr/bin/env node
// Merges the per-context ZAP reports into reports/zap.json (the findings report the gate reads) and checks that each
// context really exercised the stack: an authenticated context answered mostly by 401 is not a baseline.
// Usage: evaluate.mjs DIR OUT_ZAP_JSON
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselinePolicy } from '../lib/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [dir, outFile] = process.argv.slice(2);
const { baselines } = baselinePolicy();
const target = baselines.dast;
const results = join(here, '..', 'lib', 'results.mjs');
const add = (name, ok, detail) => spawnSync('node', [results, 'add', 'dast', name, ok ? 'pass' : 'fail', detail]);
spawnSync('node', [results, 'reset', 'dast']);

const merged = { '@programName': 'ZAP', '@version': null, site: [] };
const contexts = [];
let allOk = true;
for (const context of target.contexts) {
  const summary = JSON.parse(readFileSync(join(dir, `${context}.summary.json`), 'utf8'));
  const report = JSON.parse(readFileSync(join(dir, `${context}.json`), 'utf8'));
  merged['@version'] = summary.toolVersion;
  // Stable site names: the stack's ports change every run, the findings' identity must not.
  for (const site of report.site ?? []) {
    const name = site['@name'] === summary.apiUrl ? `stack://${context}/api` : site['@name'] === summary.webUrl ? `stack://${context}/web` : `stack://${context}/other`;
    merged.site.push({ ...site, '@name': name, '@host': name, '@port': '0' });
  }
  const by = summary.byStatus;
  const answered = Object.entries(by).filter(([k]) => !k.endsWith(':notSent'));
  const total = answered.reduce((n, [, v]) => n + v, 0);
  const share401 = total ? answered.filter(([k]) => k.endsWith(':401')).reduce((n, [, v]) => n + v, 0) / total : 1;
  const ok2xx = answered.filter(([k]) => /:2\d\d$/.test(k)).reduce((n, [, v]) => n + v, 0);
  const forbidden = answered.filter(([k]) => k === 'api:403').reduce((n, [, v]) => n + v, 0);
  contexts.push({ context, messages: summary.messages, answered: total, byStatus: by, share401, ok2xx });
  if (context === 'anonymous') {
    const refused = by['api:401'] ?? 0;
    const okA = refused > 0;
    add(`TC-NFR-10 anonymous context: protected api routes refuse with 401`, okA, `${refused} 401 answers`);
    allOk &&= okA;
  } else {
    const okSession = share401 <= target.maxUnauthorizedShare && ok2xx >= target.minAuthenticatedRequests;
    add(`TC-NFR-10 ${context} context answered with its session`, okSession, `${ok2xx} 2xx answers of ${total}; ${(share401 * 100).toFixed(1)}% were 401 (limit ${target.maxUnauthorizedShare * 100}%, at least ${target.minAuthenticatedRequests} 2xx): a run answered mostly by 401s is not counted`);
    allOk &&= okSession;
    if (context === 'user') {
      const okRole = forbidden > 0;
      add('TC-NFR-10 user context is refused on admin routes (role boundary)', okRole, `${forbidden} 403 answers`);
      allOk &&= okRole;
    }
  }
}
writeFileSync(outFile, JSON.stringify(merged, null, 2));
writeFileSync(join(dir, 'contexts.json'), JSON.stringify({ tool: 'OWASP ZAP', version: merged['@version'], policy: target, contexts, result: allOk ? 'pass' : 'fail' }, null, 2));
process.stdout.write(contexts.map((c) => `${c.context}: ${c.answered} answered, ${c.ok2xx} 2xx, ${(c.share401 * 100).toFixed(1)}% 401`).join('\n') + `\ndast session checks: ${allOk ? 'pass' : 'FAIL'}\n`);
process.exit(allOk ? 0 : 1);
