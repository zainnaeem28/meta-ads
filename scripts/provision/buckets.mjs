#!/usr/bin/env node
// R2 buckets with lock and lifecycle rules as code (DO-11, TASK-018; SB v6 7.1 C, SB-D23; docs/ops/backup.md).
//
//   node scripts/provision/buckets.mjs plan   --env staging|production      the desired state as JSON; no network, no credential
//   node scripts/provision/buckets.mjs apply  --env ... [--g3-record FILE]  create what is missing, then set the rules (idempotent)
//   node scripts/provision/buckets.mjs verify --env ...                     read every bucket and rule back and compare; read-only
//
// Environment (names only; values are never printed):
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ADMIN_TOKEN   the OWNER's Admin credential (SB-D23). The service holds none of it.
//   CLOUDFLARE_API_URL (https://api.cloudflare.com/client/v4)   the tests point it at a local stand-in
//   BACKUP_RETENTION_DAYS (30; 7 to 365)   PROVISION_G3_RECORD   PROVISION_LOCAL=1 (the stand-in; needs a localhost API URL)
// Without the account id and the token it calls nothing and exits 0 with "deployment-ready-not-deployed", listing what the
// owner adds. apply on a hosted account needs the environment's G3 record (decision PASS, same environment).
// The request shapes follow Cloudflare's R2 API for buckets, lifecycle and lock rules and are VERIFY items until the owner's
// first run (docs/ops/provisioning.md); the tests prove the script against a stand-in, not against Cloudflare.
// Exit codes: 0 done / not deployed, 1 a request or read-back failed, 2 usage, 3 refused (no G3, wrong target).

import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DAY = 86400;
export function desired(env, retentionDays = 30) {
  if (!['staging', 'production'].includes(env))
    throw new Error('env must be staging or production');
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365)
    throw new Error('BACKUP_RETENTION_DAYS must be an integer from 7 to 365');
  const name = (suffix) => `shroomap-${env}-${suffix}`;
  return {
    environment: env,
    buckets: [
      {
        name: name('app'),
        purpose: 'application media (private, signed URLs only)',
        lock: [],
        lifecycle: [],
      },
      {
        name: name('erasure-ledger'),
        purpose: 'write-once erasure ledger (token C; private)',
        lock: [],
        lifecycle: [],
      },
      {
        name: name('backup'),
        purpose: 'backup sink (daily dump, media mirror, ledger mirror)',
        // Indefinite retention on ledger/, the age lock on the whole bucket (SB v6 7.1 C).
        lock: [
          {
            id: 'ledger-indefinite',
            enabled: true,
            prefix: 'ledger/',
            condition: { type: 'Indefinite' },
          },
          {
            id: 'bucket-age',
            enabled: true,
            condition: { type: 'Age', maxAgeSeconds: retentionDays * DAY },
          },
        ],
        // Expire db/, manifests/ and media-deleted/ after retention + 1 days; none on media/ or ledger/.
        lifecycle: ['db/', 'manifests/', 'media-deleted/'].map((prefix) => ({
          id: `expire-${prefix.replace('/', '')}`,
          enabled: true,
          conditions: { prefix },
          deleteObjectsTransition: {
            condition: { type: 'Age', maxAge: (retentionDays + 1) * DAY },
          },
        })),
      },
    ],
  };
}

export const OWNER_ADDITIONS = [
  'CLOUDFLARE_ACCOUNT_ID',
  "CLOUDFLARE_ADMIN_TOKEN (the owner's Admin API token with R2 edit permission; kept out of every repository, run and ticket)",
];

class Failure extends Error {}

function client(base, account, token) {
  return async (method, path, body) => {
    const response = await globalThis.fetch(`${base}/accounts/${account}/r2/buckets${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = {};
    try {
      json = await response.json();
    } catch {
      /* no body */
    }
    return {
      status: response.status,
      ok: response.ok && json.success !== false,
      result: json.result,
      errors: json.errors ?? [],
    };
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rulesOf = (r) => r?.rules ?? [];

export async function run(mode, env, options) {
  const want = desired(env, options.retentionDays);
  const api = client(options.base, options.account, options.token);
  const log = options.log ?? (() => {});
  const problems = [];
  for (const bucket of want.buckets) {
    const path = `/${encodeURIComponent(bucket.name)}`;
    const seen = await api('GET', path);
    if (mode === 'apply') {
      if (seen.status === 404) {
        const created = await api('POST', '', { name: bucket.name });
        if (!created.ok)
          throw new Failure(
            `create ${bucket.name}: HTTP ${created.status} ${created.errors.map((e) => e.message ?? e.code).join('; ')}`,
          );
        log(`created bucket ${bucket.name}`);
      } else if (!seen.ok) throw new Failure(`read ${bucket.name}: HTTP ${seen.status}`);
      else log(`bucket ${bucket.name} exists`);
      for (const [kind, rules] of [
        ['lifecycle', bucket.lifecycle],
        ['lock', bucket.lock],
      ]) {
        const put = await api('PUT', `${path}/${kind}`, { rules });
        if (!put.ok)
          throw new Failure(
            `set ${kind} on ${bucket.name}: HTTP ${put.status} ${put.errors.map((e) => e.message ?? e.code).join('; ')}`,
          );
      }
    } else if (seen.status === 404) {
      problems.push(`${bucket.name}: bucket missing`);
      continue;
    } else if (!seen.ok) throw new Failure(`read ${bucket.name}: HTTP ${seen.status}`);
    // Read back, always: the rules the host reports must equal the rules asked for.
    for (const [kind, rules] of [
      ['lifecycle', bucket.lifecycle],
      ['lock', bucket.lock],
    ]) {
      const got = await api('GET', `${path}/${kind}`);
      if (!got.ok) throw new Failure(`read back ${kind} of ${bucket.name}: HTTP ${got.status}`);
      if (same(rulesOf(got.result), rules))
        log(`ok ${bucket.name} ${kind}: ${rules.length} rule(s) read back equal`);
      else problems.push(`${bucket.name}: ${kind} rules read back differ from the plan`);
    }
  }
  return problems;
}

export function parseArgs(argv) {
  const out = { mode: argv[0], env: '', g3: process.env.PROVISION_G3_RECORD };
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] === '--env') out.env = argv[i + 1];
    else if (argv[i] === '--g3-record') out.g3 = argv[i + 1];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!['plan', 'apply', 'verify'].includes(args.mode))
      throw new Error('mode must be plan, apply or verify');
    desired(args.env);
  } catch (e) {
    console.error(
      `usage: buckets.mjs plan|apply|verify --env staging|production [--g3-record FILE]\n${e.message}`,
    );
    return 2;
  }
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
  if (args.mode === 'plan') {
    console.log(JSON.stringify(desired(args.env, retentionDays), null, 2));
    return 0;
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_ADMIN_TOKEN;
  if (!account || !token) {
    console.log(
      `buckets: deployment-ready-not-deployed: no Cloudflare account; the owner sets ${OWNER_ADDITIONS.join(' and ')} (docs/ops/provisioning.md)`,
    );
    return 0;
  }
  const base = (process.env.CLOUDFLARE_API_URL ?? 'https://api.cloudflare.com/client/v4').replace(
    /\/$/,
    '',
  );
  const local =
    /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base) && process.env.PROVISION_LOCAL === '1';
  if (args.mode === 'apply' && !local) {
    try {
      const record = JSON.parse(readFileSync(args.g3 ?? '', 'utf8'));
      if (record.decision !== 'PASS' || record.environment !== args.env)
        throw new Error('not a PASS for this environment');
    } catch (e) {
      console.error(
        `refusing: no usable G3 record for ${args.env} (${e.message}); nothing is created before the G3 for that environment`,
      );
      return 3;
    }
  }
  if (!local && !base.startsWith('https://')) {
    console.error('refusing: the API URL must be https');
    return 3;
  }
  try {
    const problems = await run(args.mode, args.env, {
      base,
      account,
      token,
      retentionDays,
      log: (m) => console.log(m),
    });
    for (const p of problems) console.error(`FAIL ${p}`);
    console.log(
      problems.length === 0
        ? `buckets: ${args.mode} complete`
        : `buckets: ${problems.length} problem(s)`,
    );
    return problems.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(
      `buckets: ${e instanceof Failure ? e.message : `unexpected: ${e.message}`}`.replaceAll(
        token,
        '***',
      ),
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exit(await main());
