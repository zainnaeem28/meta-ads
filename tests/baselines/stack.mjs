#!/usr/bin/env node
/* global Buffer, fetch, setTimeout, process */
// The stack the baselines run against (QUALITY-RELEASE-PLAN section 6): the built api and the built web on this host,
// a uniquely named database with per-run roles on the shared test PostgreSQL, the real migrations, the reference and
// development seeds, and the baseline dataset (25 accounts, 5 running stub jobs each). Nothing here is a real
// credential: keys are generated now, the identity provider's key set is answered locally (support/clerk-stub-preload.mjs).
//
//   stack.mjs up   [--state DIR]   start everything, write DIR/state.json (urls, throwaway tokens, pids)
//   stack.mjs down [--state DIR]   stop the processes, drop the database and roles
//
// Environment: BASELINE_ADMIN_URL (default postgres://postgres@test-db:5432/postgres, the shared test PostgreSQL).
import { spawn, spawnSync } from 'node:child_process';
import {
  createHmac,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const apiDir = join(root, 'apps', 'api');
const webDir = join(root, 'apps', 'web');
const require = createRequire(join(apiDir, 'package.json'));
const pg = require('pg');

// Fixed identifiers of the development dataset (apps/api/src/database/seeds/fixtures.ts).
const DEV_ADMIN_ID = '0197a1b2-0000-7000-8000-00000000d001';
const DEV_MEMBER_ID = '0197a1b2-0000-7000-8000-00000000d002';
export const ACCOUNTS = 25;
export const JOBS_PER_ACCOUNT = 5;
const ISSUER = 'https://clerk.baseline.invalid';
const LOCAL_SESSION_SECRET = 'shroomap-local-auth-development-only'; // the web's fixed development value (local-session.ts)

const b64u = (value) => Buffer.from(value).toString('base64url');
const ident = (name) => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe identifier ${name}`);
  return `"${name}"`;
};

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

function freePort() {
  return new Promise((ok, fail) => {
    const server = net.createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

function portIsFree(port) {
  return new Promise((ok) => {
    const server = net.createServer();
    server.once('error', () => ok(false));
    server.listen(port, '127.0.0.1', () => server.close(() => ok(true)));
  });
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function urlFor(adminUrl, user, password, database) {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

function run(cmd, args, options) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${r.status}\n${(r.stdout ?? '').slice(-2000)}\n${(r.stderr ?? '').slice(-2000)}`,
    );
  }
  return r.stdout;
}

async function waitFor(url, label, timeoutMs, logFile) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = logFile && existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-1500) : '';
  throw new Error(`${label} did not answer ${url} in ${timeoutMs} ms\n${tail}`);
}

function startProcess(name, cmd, args, { cwd, env, stateDir }) {
  const log = join(stateDir, `${name}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  return { pid: child.pid, log };
}

function mintToken(privateKey, kid, sub) {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))}.${b64u(
    JSON.stringify({
      iss: ISSUER,
      sub,
      sid: `sess_${sub}`,
      iat: now,
      exp: now + 3 * 3600,
      fva: [1, 1],
    }),
  )}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}`;
}

function localSessionCookie(sub, email) {
  const payload = b64u(
    JSON.stringify({ sub, email, exp: Math.floor(Date.now() / 1000) + 3 * 3600 }),
  );
  return `${payload}.${createHmac('sha256', LOCAL_SESSION_SECRET).update(payload).digest('base64url')}`;
}

/** Everything the baseline dataset adds on top of the development seed: accounts, campaigns, briefs and running stub jobs. */
async function loadDataset(url) {
  await withClient(url, async (c) => {
    await c.query('begin');
    await c.query(
      `insert into users (id, idp_subject, email, role, status, linked_via) values
         ($1, 'user_seed_admin', 'seed.admin@example.invalid', 'admin', 'active', 'first_admin'),
         ($2, 'user_seed_member', 'seed.member@example.invalid', 'user', 'active', 'invitation')`,
      [DEV_ADMIN_ID, DEV_MEMBER_ID],
    );
    const users = [{ id: DEV_MEMBER_ID, n: 1 }];
    for (let n = 2; n <= ACCOUNTS; n += 1) {
      const id = randomUUID();
      const tag = String(n).padStart(2, '0');
      await c.query(
        `insert into users (id, idp_subject, email, role, status, linked_via)
         values ($1, $2, $3, 'user', 'active', 'invitation')`,
        [id, `user_baseline_${tag}`, `baseline.user${tag}@example.invalid`],
      );
      users.push({ id, n });
    }
    for (const user of users) {
      for (let k = 1; k <= JOBS_PER_ACCOUNT; k += 1) {
        const campaignId = randomUUID();
        const briefId = randomUUID();
        const segmentId = randomUUID();
        await c.query(
          `insert into campaigns (id, owner_id, state, product_name, product_description, segment_count)
           values ($1, $2, 'active', $3, 'Synthetic campaign of the baseline dataset.', 1)`,
          [campaignId, user.id, `Baseline product ${user.n}-${k}`],
        );
        await c.query(
          `insert into drafts (id, owner_id, step, product_name, product_description, segment_count, campaign_id)
           values ($1, $2, 5, $3, 'Synthetic campaign of the baseline dataset.', 1, $4)`,
          [randomUUID(), user.id, `Baseline product ${user.n}-${k}`, campaignId],
        );
        await c.query(
          `insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, 'accepted', now())`,
          [briefId, campaignId, user.id],
        );
        await c.query(
          `insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count)
           values ($1, $2, 1, 'Synthetic dialogue.', 'Synthetic prompt.', 2)`,
          [segmentId, briefId],
        );
        await c.query(
          `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, provider_model, options,
                                   state, reuse_hash, deadline_at, provider_task_id)
           values ($1, $2, $3, $4, 1, 'stub-video-model', '{}'::jsonb, 'processing', $5, now() + interval '1 day', $6)`,
          [
            randomUUID(),
            user.id,
            campaignId,
            segmentId,
            randomBytes(32).toString('hex'),
            `stub-task-${user.n}-${k}`,
          ],
        );
      }
    }
    await c.query('commit');
  });
}

async function up(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const adminUrl = process.env.BASELINE_ADMIN_URL ?? 'postgres://postgres@test-db:5432/postgres';
  const suffix = randomBytes(4).toString('hex');
  const database = `bl_${suffix}`;
  const roles = {
    migrator: `app_migrator_${suffix}`,
    api: `app_api_${suffix}`,
    worker: `app_worker_${suffix}`,
    backup: `app_backup_${suffix}`,
  };
  const secret = () => randomBytes(18).toString('hex');
  const passwords = { migrator: secret(), api: secret(), worker: secret(), backup: secret() };
  const state = {
    suffix,
    database,
    roles,
    pids: {},
    dbAdminUrl: adminUrl,
    startedAt: new Date().toISOString(),
  };
  const save = () =>
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  save();

  // 1. database and roles (the way the host provisions them; names carry the run suffix so runs side by side never clash)
  await withClient(adminUrl, async (c) => {
    for (const key of Object.keys(roles)) {
      const extra =
        key === 'backup' ? 'NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2' : '';
      await c.query(
        `CREATE ROLE ${ident(roles[key])} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${extra} PASSWORD '${passwords[key]}'`,
      );
      if (key !== 'backup')
        await c.query(`ALTER ROLE ${ident(roles[key])} SET search_path = public`);
    }
    await c.query(`ALTER ROLE ${ident(roles.backup)} SET default_transaction_read_only = on`);
    await c.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(roles.migrator)}`);
  });
  await withClient(
    urlFor(adminUrl, new URL(adminUrl).username, new URL(adminUrl).password, database),
    async (c) => {
      await c.query(`REVOKE CONNECT ON DATABASE ${ident(database)} FROM PUBLIC`);
      await c.query(
        `GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(roles.api)}, ${ident(roles.worker)}, ${ident(roles.backup)}`,
      );
      await c.query(`ALTER SCHEMA public OWNER TO ${ident(roles.migrator)}`);
    },
  );
  const dbUrl = (role) => urlFor(adminUrl, roles[role], passwords[role], database);

  // 2. process configuration: the generated local environment files, with this run's database and identity settings
  const envDir = mkdtempSync(join(tmpdir(), `bl-env-${suffix}-`));
  run('node', [join(root, 'scripts', 'ci', 'config-consistency.mjs'), '--local-env', envDir], {
    cwd: root,
  });
  // A stable api port keeps the web build (NEXT_PUBLIC_API_ORIGIN is baked in) reusable between runs; a busy one falls back to a free port.
  const preferred = Number(process.env.BASELINE_API_PORT ?? 4317);
  const apiPort = (await portIsFree(preferred)) ? preferred : await freePort();
  const webPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const releaseEnv = {
    ...process.env,
    ...parseEnvFile(join(envDir, 'release.env')),
    APP_ENV: 'development',
    MIGRATION_DATABASE_URL: dbUrl('migrator'),
  };
  delete releaseEnv.DATABASE_URL;
  // The release process refuses every api secret (config class "forbidden"), and the development dataset's provider-key
  // step needs the KEK and pepper, so only the reference dataset runs through the seed command; the development
  // accounts are written by loadDataset with the same fixed identifiers (fixtures.ts).

  // 3. migrate (real migrations, role names rewritten to this run's), jobs, seeds, price table, ledger grant
  const migDir = mkdtempSync(join(tmpdir(), `bl-mig-${suffix}-`));
  cpSync(join(apiDir, 'src', 'database', 'migrations'), join(migDir, 'migrations'), {
    recursive: true,
  });
  for (const name of readdirSync(join(migDir, 'migrations')).filter((n) => n.endsWith('.sql'))) {
    const file = join(migDir, 'migrations', name);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /\bapp_(migrator|api|worker|backup)\b/g,
        (_all, key) => roles[key],
      ),
    );
  }
  writeFileSync(
    join(migDir, 'drizzle.config.ts'),
    `export default { dialect: 'postgresql', out: './migrations', dbCredentials: { url: process.env.MIGRATION_DATABASE_URL } };\n`,
  );
  run(
    join(apiDir, 'node_modules', '.bin', 'drizzle-kit'),
    ['migrate', '--config', join(migDir, 'drizzle.config.ts')],
    {
      cwd: migDir,
      env: { ...releaseEnv, CI: '1' },
    },
  );
  rmSync(migDir, { recursive: true, force: true });
  const jobs = await import(
    pathToFileURL(join(apiDir, 'dist', 'database', 'jobs-migrate.js')).href
  );
  await jobs.migrateJobs(dbUrl('migrator'), undefined, { api: roles.api, worker: roles.worker });
  for (const dataset of ['reference']) {
    run('node', [join(apiDir, 'dist', 'database', 'seed.js'), `--dataset=${dataset}`], {
      cwd: apiDir,
      env: releaseEnv,
    });
  }
  const price = JSON.parse(readFileSync(join(root, 'config', 'price-table.json'), 'utf8')).rows;
  await withClient(dbUrl('migrator'), async (c) => {
    for (const x of price) {
      await c.query(
        `insert into price_table values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
        [x.provider, x.operation, x.effectiveFrom, x.unit, x.unitPriceUsd, x.unitsPerCall],
      );
    }
    await c.query(`GRANT USAGE ON SCHEMA drizzle TO ${ident(roles.api)}`);
    await c.query(`GRANT SELECT ON drizzle.__drizzle_migrations TO ${ident(roles.api)}`);
  });
  await loadDataset(dbUrl('migrator'));

  // 4. identity: a throwaway key pair; the api's key-set request is answered from this file (clerk-stub-preload.mjs)
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `baseline-${suffix}`;
  const jwksFile = join(stateDir, 'jwks.json');
  writeFileSync(
    jwksFile,
    JSON.stringify({
      keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
    }),
  );
  const pk = createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  // The api preload signs the web's local-session token requests with this throwaway key (clerk-stub-preload.mjs).
  writeFileSync(
    join(stateDir, 'signing-key.pem'),
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    {
      mode: 0o600,
    },
  );

  // 5. the api
  const apiEnv = {
    ...process.env,
    ...parseEnvFile(join(envDir, 'api.env')),
    APP_ENV: 'development',
    API_PORT: String(apiPort),
    WEB_ORIGIN: webUrl,
    DATABASE_URL: dbUrl('api'),
    IDENTITY_MODE: 'clerk',
    CLERK_JWT_ISSUER: ISSUER,
    CLERK_SECRET_KEY: 'sk_test_baseline_synthetic',
    BASELINE_JWKS_FILE: jwksFile,
    BASELINE_SIGNING_KEY_FILE: join(stateDir, 'signing-key.pem'),
    BASELINE_SESSIONS_FILE: join(stateDir, 'sessions.json'),
    NODE_OPTIONS: `--import=${pathToFileURL(join(here, 'support', 'clerk-stub-preload.mjs')).href}`,
    LOG_LEVEL: 'warn',
  };
  state.pids.api = startProcess('api', 'node', [join(apiDir, 'dist', 'main.api.js')], {
    cwd: apiDir,
    env: apiEnv,
    stateDir,
  });
  save();
  await waitFor(`${apiUrl}/health/live`, 'api', 60_000, state.pids.api.log);
  await waitFor(`${apiUrl}/health/ready`, 'api ready', 30_000, state.pids.api.log);

  // 6. the web, built with this run's api origin baked in (NEXT_PUBLIC_*), started from the production build
  const webEnv = {
    ...process.env,
    ...parseEnvFile(join(envDir, 'web.env')),
    APP_ENV: 'development',
    AUTH_MODE: 'local',
    WEB_ORIGIN: webUrl,
    NEXT_PUBLIC_API_ORIGIN: apiUrl,
    // Local sessions: no identity-provider script. With the placeholder key the page loads clerk-js from an unreachable
    // host and spins on the main thread (TBT of a minute), which would measure the sandbox, not the product.
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
  };
  const buildTag = `${apiUrl}|no-clerk-key`;
  const marker = join(webDir, '.next', '.baseline-api-origin');
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== buildTag) {
    run('pnpm', ['exec', 'next', 'build'], { cwd: webDir, env: webEnv });
    writeFileSync(marker, buildTag);
  }
  state.pids.web = startProcess(
    'web',
    'pnpm',
    ['exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', String(webPort)],
    {
      cwd: webDir,
      env: webEnv,
      stateDir,
    },
  );
  save();
  await waitFor(`${webUrl}/sign-in`, 'web', 60_000, state.pids.web.log);

  // 7. synthetic sessions (never a real user's): api bearer tokens and the web's local session cookie
  const subjects = [{ sub: 'user_seed_member', email: 'seed.member@example.invalid' }];
  for (let n = 2; n <= ACCOUNTS; n += 1) {
    const tag = String(n).padStart(2, '0');
    subjects.push({ sub: `user_baseline_${tag}`, email: `baseline.user${tag}@example.invalid` });
  }
  const admin = { sub: 'user_seed_admin', email: 'seed.admin@example.invalid' };
  Object.assign(state, {
    apiUrl,
    webUrl,
    users: subjects.map((s) => ({
      ...s,
      token: mintToken(pk, kid, s.sub),
      cookie: localSessionCookie(s.sub, s.email),
    })),
    admin: {
      ...admin,
      token: mintToken(pk, kid, admin.sub),
      cookie: localSessionCookie(admin.sub, admin.email),
    },
    ready: true,
  });
  writeFileSync(
    join(stateDir, 'sessions.json'),
    JSON.stringify([...subjects, admin].map((x) => ({ sub: x.sub, email: x.email, kid }))),
  );
  save();
  rmSync(envDir, { recursive: true, force: true });
  process.stdout.write(
    `stack up: api ${apiUrl} web ${webUrl} database ${database} (${subjects.length} accounts, ${subjects.length * JOBS_PER_ACCOUNT} stub jobs)\n`,
  );
}

async function down(stateDir) {
  const file = join(stateDir, 'state.json');
  if (!existsSync(file)) return;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  for (const { pid } of Object.values(state.pids ?? {})) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  for (const { pid } of Object.values(state.pids ?? {})) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await withClient(state.dbAdminUrl, async (c) => {
    await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [
      state.database,
    ]);
    await c.query(`DROP DATABASE IF EXISTS ${ident(state.database)} WITH (FORCE)`);
    for (const role of Object.values(state.roles))
      await c.query(`DROP ROLE IF EXISTS ${ident(role)}`);
  });
  rmSync(file, { force: true });
  process.stdout.write(`stack down: database ${state.database} and roles dropped\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const at = rest.indexOf('--state');
  const stateDir = resolve(
    at >= 0
      ? rest[at + 1]
      : (process.env.BASELINE_STATE_DIR ?? join(root, 'reports', 'baselines', 'state')),
  );
  const fn = command === 'up' ? up : command === 'down' ? down : null;
  if (!fn) {
    process.stderr.write('usage: stack.mjs up|down [--state DIR]\n');
    process.exit(2);
  }
  fn(stateDir).catch(async (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    if (command === 'up') await down(stateDir).catch(() => undefined);
    process.exit(1);
  });
}
