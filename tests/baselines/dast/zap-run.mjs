#!/usr/bin/env node
/* global setTimeout, fetch */
// One ZAP baseline run (spider and passive scan, no active attack) for one context against the baseline stack.
//   zap-run.mjs --context anonymous|user|admin --state STATE.json --out DIR [--smoke]
// Writes DIR/<context>.json (ZAP traditional JSON) and DIR/<context>.summary.json (what was reached). The session of
// the context is added to every request to the stack by a replacer rule: a bearer token for the api origin, the web's
// local session cookie for the web origin. Anonymous sends neither.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const context = arg('context');
const state = JSON.parse(readFileSync(arg('state'), 'utf8'));
const outDir = resolve(arg('out'));
const smoke = process.argv.includes('--smoke');
if (!['anonymous', 'user', 'admin'].includes(context))
  throw new Error('--context must be anonymous, user or admin');
mkdirSync(outDir, { recursive: true });

const tools = process.env.CI_TOOLS_DIR ?? join(process.env.HOME, '.cache', 'shroomap-ci-tools');
const zapHome = join(tools, 'zap', 'ZAP_2.17.0');
const account = context === 'admin' ? state.admin : context === 'user' ? state.users[1] : null;

const freePort = () =>
  new Promise((ok, fail) => {
    const s = net.createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const port = await freePort();
const home = mkdtempSync(join(tmpdir(), 'zap-home-'));
const zap = spawn(
  join(zapHome, 'zap.sh'),
  [
    '-daemon',
    '-host',
    '127.0.0.1',
    '-port',
    String(port),
    '-dir',
    home,
    '-config',
    'api.disablekey=true',
    '-config',
    'connection.timeoutInSecs=30',
    '-nostdout',
  ],
  {
    env: {
      ...process.env,
      PATH: `${join(tools, 'jre', 'bin')}:${process.env.PATH}`,
      JAVA_HOME: join(tools, 'jre'),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  },
);
const stop = async () => {
  try {
    await call('core/action/shutdown');
  } catch {
    // already down
  }
  await new Promise((r) => setTimeout(r, 2000));
  try {
    process.kill(-zap.pid, 'SIGKILL');
  } catch {
    // gone
  }
  rmSync(home, { recursive: true, force: true });
};

async function call(path, params = {}) {
  const url = new URL(`http://127.0.0.1:${port}/JSON/${path}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`ZAP ${path}: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, test, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`ZAP: ${label} did not finish in ${timeoutMs} ms`);
    await sleep(everyMs);
  }
}

try {
  await until(
    'start',
    async () => (await call('core/view/version').catch(() => null)) !== null,
    120_000,
    1500,
  );
  const version = (await call('core/view/version')).version;

  if (account) {
    const esc = (u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = (description, header, value, origin) =>
      call('replacer/action/addRule', {
        description,
        enabled: 'true',
        matchType: 'REQ_HEADER',
        matchRegex: 'false',
        matchString: header,
        replacement: value,
        initiators: '',
        url: `${esc(origin)}.*`,
      });
    await rule(`${context}-api-session`, 'Authorization', `Bearer ${account.token}`, state.apiUrl);
    await rule(
      `${context}-web-session`,
      'Cookie',
      `shroomap_local_session=${account.cookie}`,
      state.webUrl,
    );
  }
  // Scope: the stack only. Nothing outside it is ever requested.
  const scope = `${state.apiUrl.replace(/[.]/g, '\\.')}.*|${state.webUrl.replace(/[.]/g, '\\.')}.*`;
  await call('context/action/newContext', { contextName: context });
  await call('context/action/includeInContext', {
    contextName: context,
    regex: state.apiUrl.replace(/[.]/g, '\\.') + '.*',
  });
  await call('context/action/includeInContext', {
    contextName: context,
    regex: state.webUrl.replace(/[.]/g, '\\.') + '.*',
  });
  await call('core/action/setMode', { mode: 'protect' });

  // The api: the contract's operations (the add-on requests each one), then the web's routes by spider.
  await call('openapi/action/importFile', {
    file: join(root, 'packages', 'contracts', 'openapi.yaml'),
    target: `${state.apiUrl}/api/v1`,
  });
  const routes = [
    '/sign-in',
    '/access',
    '/campaigns',
    '/campaigns/new',
    '/settings/provider-keys',
    '/admin/usage',
    '/admin/accounts',
    '/admin/alerts',
    '/admin/invitations',
    '/admin/settings',
  ];
  if (account) {
    const list = await fetch(`${state.apiUrl}/api/v1/campaigns?limit=1`, {
      headers: { Authorization: `Bearer ${account.token}` },
    });
    const first = list.ok ? (await list.json()).data?.[0]?.id : null;
    if (first)
      routes.push(
        `/campaigns/${first}/brief`,
        `/campaigns/${first}/clips`,
        `/campaigns/${first}/final`,
      );
  }
  if (account) {
    // Real read operations with real identifiers, so the authenticated surface is reached and not only generated requests.
    const campaignId = routes.find((r) => r.endsWith('/brief'))?.split('/')[2];
    const reads =
      context === 'admin'
        ? [
            '/me',
            '/campaigns',
            '/admin/users',
            '/admin/erasures',
            '/admin/invitations',
            '/admin/access-requests',
            '/admin/settings',
            '/admin/alerts',
            '/admin/usage-report',
            '/admin/usage-report.csv',
          ]
        : [
            '/me',
            '/campaigns',
            '/drafts',
            '/me/provider-keys',
            '/me/key-events',
            ...(campaignId
              ? [
                  `/campaigns/${campaignId}`,
                  `/campaigns/${campaignId}/brief`,
                  `/campaigns/${campaignId}/video-jobs`,
                ]
              : []),
            '/admin/users',
          ];
    for (const path of reads) {
      // sent through ZAP (the proxy) so the passive scanner sees the exchange
      await call('core/action/sendRequest', {
        request: `GET ${state.apiUrl}/api/v1${path} HTTP/1.1\r\nHost: ${new URL(state.apiUrl).host}\r\nAuthorization: Bearer ${account.token}\r\n\r\n`,
        followRedirects: 'false',
      });
    }
  }
  for (const route of routes)
    await call('core/action/accessUrl', {
      url: `${state.webUrl}${route}`,
      followRedirects: 'true',
    });
  const spider = await call('spider/action/scan', {
    url: `${state.webUrl}/sign-in`,
    maxChildren: smoke ? '10' : '50',
    recurse: 'true',
    contextName: context,
    subtreeOnly: 'false',
  });
  await until(
    'spider',
    async () => Number((await call('spider/view/status', { scanId: spider.scan })).status) >= 100,
    smoke ? 120_000 : 600_000,
  );
  await until(
    'passive scan',
    async () => Number((await call('pscan/view/recordsToScan')).recordsToScan) === 0,
    300_000,
  );

  // What was reached, by status: the proof that the session was accepted (a run answered mostly by 401 is not a baseline).
  const total = Number((await call('core/view/numberOfMessages')).numberOfMessages);
  const byStatus = {};
  for (let start = 0; start < total; start += 500) {
    const page = (await call('core/view/messages', { start: String(start), count: '500' }))
      .messages;
    for (const m of page) {
      if (
        !m.requestHeader.includes(state.apiUrl.replace('http://', '')) &&
        !m.requestHeader.includes(state.webUrl.replace('http://', ''))
      )
        continue;
      const code = (m.responseHeader.match(/^HTTP\/\S+ ([1-9]\d{2})/) ?? [])[1] ?? 'notSent'; // "HTTP/1.0 0": ZAP's own placeholder requests of the import
      if (code === 'notSent' && process.env.BASELINE_DEBUG)
        process.stderr.write(
          `none: ${m.requestHeader.split('\r\n')[0]} -> ${JSON.stringify(m.responseHeader.slice(0, 80))}\n`,
        );
      const side = m.requestHeader.includes(state.apiUrl.replace('http://', '')) ? 'api' : 'web';
      byStatus[`${side}:${code}`] = (byStatus[`${side}:${code}`] ?? 0) + 1;
    }
  }
  const report = join(outDir, `${context}.json`);
  await call('reports/action/generate', {
    title: `ShrooMap baseline ${context}`,
    template: 'traditional-json',
    reportDir: outDir,
    reportFileName: `${context}.json`,
    display: 'false',
  });
  writeFileSync(
    join(outDir, `${context}.summary.json`),
    JSON.stringify(
      {
        context,
        tool: 'OWASP ZAP',
        toolVersion: version,
        scope,
        apiUrl: state.apiUrl,
        webUrl: state.webUrl,
        messages: total,
        byStatus,
        report: report.replace(`${root}/`, ''),
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `zap ${context}: ZAP ${version}, ${total} messages, ${JSON.stringify(byStatus)}\n`,
  );
} finally {
  await stop();
}
