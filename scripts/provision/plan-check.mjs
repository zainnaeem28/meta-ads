#!/usr/bin/env node
// The provisioning plan check (DO-11, TASK-018), run by plan.sh --check. No credential, no account, no cloud resource:
//   1 the Render Blueprints (lint, currency, one injected defect at a time)
//   2 connection capacity: the 47-connection peak recomputed from the pool counts
//   3 roles and grants: roles.sh on a disposable database of the shared test PostgreSQL, as a non-superuser CREATEROLE admin
//     the way the host creates them, applied twice, read back, drifted, refused when elevated, and used as app_backup
//   4 buckets, lock and lifecycle rules: buckets.mjs against a local stand-in of the Cloudflare R2 API (apply twice, read back,
//     drift, host errors), plus the no-credential and no-G3 paths
// Usage: node plan-check.mjs [--junit FILE] [--record FILE]. Exit 0 only when every check passed.
// Environment: PROVISION_PG_ADMIN_URL (default postgres://postgres@test-db:5432/postgres, a disposable test server: the script
// refuses any other host name), PSQL_BIN.

import { execFile } from 'node:child_process';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { check as checkBlueprints, probe as probeBlueprints } from './render-blueprint.mjs';
import { desired } from './buckets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PSQL = process.env.PSQL_BIN ?? 'psql';
const ADMIN_URL = process.env.PROVISION_PG_ADMIN_URL ?? 'postgres://postgres@test-db:5432/postgres';

const results = [];
const out = [];
const say = (line) => out.push(line);
async function step(name, fn) {
  const t0 = Date.now();
  const notes = [];
  try {
    await fn((n) => notes.push(n));
    results.push({ name, ok: true, ms: Date.now() - t0 });
    say(`PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, message: e.message });
    say(`FAIL ${name}: ${e.message}`);
  }
  for (const n of notes) say(`     ${n}`);
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const sh = (cmd, args, env = {}) =>
  new Promise((done) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, ...env }, maxBuffer: 1 << 24 },
      (error, stdout, stderr) =>
        done({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
          all: `${stdout}${stderr}`,
        }),
    );
  });
// One -c per statement: psql sends a multi-statement -c as one transaction, which CREATE DATABASE refuses.
const psql = (url, ...sql) =>
  sh(PSQL, ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', url, ...sql.flatMap((q) => ['-c', q])]);

// ------------------------------------------------------------------------------------------------ 1 blueprints
await step('render blueprints: lint and currency (staging, production)', async (note) => {
  const { errors, summary } = checkBlueprints(ROOT);
  summary.forEach((s) => note(s));
  assert(errors.length === 0, errors.join('; '));
});
await step('render blueprints: every injected defect is caught', async (note) => {
  const r = probeBlueprints(ROOT);
  note(`${r.filter((x) => x.caught).length} of ${r.length} defects caught`);
  const missed = r.filter((x) => !x.caught).map((x) => x.name);
  assert(missed.length === 0, `not caught: ${missed.join(', ')}`);
});

// ------------------------------------------------------------------------------------------------ 2 capacity
await step(
  "connection capacity: the peak is 47 and fits 80% of a plan's max_connections",
  async (note) => {
    const c = JSON.parse(readFileSync(join(HERE, 'capacity.json'), 'utf8'));
    const sum = (o) =>
      typeof o === 'number' ? o : Object.values(o).reduce((a, b) => a + sum(b), 0);
    const apiPool = sum(c.pools.api);
    const workerPool = sum(c.pools.worker);
    const peak =
      2 * apiPool + 2 * workerPool + c.rollingDeploy.migrate + c.pools.backup + c.pools.operator;
    assert(
      peak === c.peak && peak === 47,
      `computed peak ${peak} differs from the recorded ${c.peak} (plan: 47)`,
    );
    assert(
      apiPool + workerPool === 22,
      `steady state ${apiPool + workerPool} differs from the plan's 22`,
    );
    const needed = Math.ceil((peak * 100) / c.headroomPercent);
    note(
      `steady state ${apiPool + workerPool}, rolling-deploy peak ${peak}; a plan needs max_connections of at least ${needed}`,
    );
  },
);

// ------------------------------------------------------------------------------------------------ 3 roles and grants
const dbUrl = /^postgres(?:ql)?:\/\/([^:@/]+)(?::([^@]*))?@([^:/]+)(?::(\d+))?\//.exec(ADMIN_URL);
const pgHost = dbUrl?.[3];
const sfx = randomBytes(4).toString('hex');
const names = {
  admin: `host_admin_${sfx}`,
  db: `prov_${sfx}`,
  other: `prov_other_${sfx}`,
  suffix: `_${sfx}`,
};
const pw = {
  admin: randomBytes(9).toString('hex'),
  m: randomBytes(9).toString('hex'),
  a: randomBytes(9).toString('hex'),
  w: randomBytes(9).toString('hex'),
  b: randomBytes(9).toString('hex'),
};
const role = (k) => `app_${k}_${sfx}`;
const urlAs = (user, password, db) =>
  `postgres://${user}:${password}@${pgHost}:${dbUrl?.[4] ?? 5432}/${db}`;
const rolesEnv = (extra = {}) => ({
  PROVISION_DATABASE_URL: urlAs(names.admin, pw.admin, names.db),
  PROVISION_APP_DB: names.db,
  PROVISION_ROLE_SUFFIX: names.suffix,
  PROVISION_PW_MIGRATOR: pw.m,
  PROVISION_PW_API: pw.a,
  PROVISION_PW_WORKER: pw.w,
  PROVISION_PW_BACKUP: pw.b,
  PROVISION_LOCAL: '1',
  PROVISION_G3_RECORD: '',
  PROVISION_ENVIRONMENT: '',
  ...extra,
});
const roles = (args, extra) => sh(join(HERE, 'roles.sh'), args, rolesEnv(extra));
const mask = (text) => text.replaceAll(sfx, '<sfx>').replace(/^\s+$/gm, '');
const secrets = () => Object.values(pw);

if (
  !dbUrl ||
  (!['test-db', 'localhost', '127.0.0.1', '::1'].includes(pgHost) && !/^db-test/.test(pgHost))
) {
  await step('roles and grants', async () => {
    throw new Error(
      `PROVISION_PG_ADMIN_URL must name a disposable test server (test-db, localhost); got host ${pgHost ?? '(unparsable)'}`,
    );
  });
} else {
  const probe = await psql(ADMIN_URL, 'select 1');
  if (probe.code !== 0) {
    await step('roles and grants', async () => {
      throw new Error(`the test PostgreSQL is not reachable (${probe.all.trim().split('\n')[0]})`);
    });
  } else {
    try {
      // The host's own admin is a non-superuser with CREATEROLE: the PostgreSQL 16+ creator grant is exercised.
      const setup = await psql(
        ADMIN_URL,
        `CREATE ROLE ${names.admin} LOGIN CREATEROLE NOSUPERUSER PASSWORD '${pw.admin}'`,
        `CREATE DATABASE ${names.db} OWNER ${names.admin}`,
        `CREATE DATABASE ${names.other} OWNER ${names.admin}`,
      );
      assert(setup.code === 0, `setup failed: ${setup.all}`);
      const admin = (sql, db = names.db) => psql(urlAs(names.admin, pw.admin, db), sql);

      await step('roles: first apply creates four roles and reads them back', async (note) => {
        const r = await roles(['apply']);
        assert(r.code === 0, `exit ${r.code}: ${mask(r.all)}`);
        for (const k of ['migrator', 'api', 'worker', 'backup'])
          assert(r.all.includes(`created role ${role(k)}`), `${k} not created`);
        assert(r.all.includes('ok max_connections'), 'no max_connections read-back');
        assert(!secrets().some((s) => r.all.includes(s)), 'a password appears in the output');
        note(
          mask(
            r.all
              .split('\n')
              .filter((l) => /^(ok|roles:)/.test(l) && !/^ok database /.test(l))
              .join('\n     '),
          ),
        );
      });
      await step(
        'roles: second apply changes nothing (idempotent) and still reads back',
        async (note) => {
          const before = (
            await admin(
              `select rolname, oid, rolconnlimit from pg_roles where rolname like 'app\\_%\\_${sfx}' order by 1`,
            )
          ).stdout;
          const r = await roles(['apply']);
          assert(r.code === 0, `exit ${r.code}: ${mask(r.all)}`);
          assert(
            !/created role|rotated password/.test(r.all),
            'a second apply created or rotated something',
          );
          const after = (
            await admin(
              `select rolname, oid, rolconnlimit from pg_roles where rolname like 'app\\_%\\_${sfx}' order by 1`,
            )
          ).stdout;
          assert(before === after, 'role identity or limits changed on the second apply');
          note(`${before.trim().split('\n').length} roles unchanged`);
        },
      );
      await step(
        'roles: app_backup attributes, session default, membership and CONNECT read back from the catalogue',
        async (note) => {
          const q = await admin(
            `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname = '${role('backup')}'`,
          );
          assert(
            q.stdout.trim() === 't|f|f|f|f|f|f|2',
            `app_backup attributes: ${q.stdout.trim()}`,
          );
          const ro = await admin(
            `select count(*) from pg_db_role_setting s where s.setrole = '${role('backup')}'::regrole and s.setdatabase = 0 and 'default_transaction_read_only=on' = any (s.setconfig)`,
          );
          assert(ro.stdout.trim() === '1', 'no read-only session default');
          const mem = await admin(
            `select am.roleid::regrole, pg_has_role(am.member, am.roleid, 'USAGE') from pg_auth_members am where am.member = '${role('backup')}'::regrole`,
          );
          assert(mem.stdout.trim() === '', `app_backup is a member of a role: ${mem.stdout}`);
          const grant = await admin(
            `select am.member::regrole, am.admin_option, am.inherit_option, am.set_option from pg_auth_members am where am.roleid = '${role('backup')}'::regrole`,
          );
          const rows = grant.stdout.trim().split('\n').filter(Boolean);
          assert(
            rows.length === 1 && rows[0] === `${names.admin}|t|f|f`,
            `creator grant on app_backup: ${grant.stdout.trim()}`,
          );
          const conn = await admin(
            `select has_database_privilege('${role('backup')}', '${names.db}', 'CONNECT'), has_database_privilege('${role('backup')}', '${names.other}', 'CONNECT'), has_database_privilege('${role('api')}', '${names.other}', 'CONNECT')`,
          );
          assert(
            conn.stdout.trim() === 't|f|f',
            `CONNECT read-back: ${conn.stdout.trim()} (app db t, other db f, f)`,
          );
          note(
            'app_backup: LOGIN NOINHERIT, CONNECTION LIMIT 2, default_transaction_read_only = on, member of no role',
          );
          note(
            `creator grant (PostgreSQL 16+): ${names.admin.replace(sfx, '<sfx>')} ADMIN OPTION, INHERIT FALSE, SET FALSE, left as created`,
          );
          note(
            'CONNECT: app database granted to all four roles; the other database refused through PUBLIC',
          );
        },
      );
      await step(
        'roles: app_backup can read but never write, create or become another role',
        async () => {
          const mig = urlAs(role('migrator'), pw.m, names.db);
          const setup = await psql(mig, 'create table t(x int); insert into t values (1)');
          // The migrator has no CREATE on public until M0001 grants it; the admin (database owner) creates the fixture instead.
          const fixture =
            setup.code === 0
              ? setup
              : await psql(
                  urlAs(names.admin, pw.admin, names.db),
                  `create table t(x int); insert into t values (1); grant select on t to ${role('backup')}`,
                );
          assert(fixture.code === 0, `fixture: ${fixture.all}`);
          if (setup.code === 0) await psql(mig, `grant select on t to ${role('backup')}`);
          const b = urlAs(role('backup'), pw.b, names.db);
          assert(
            (await psql(b, 'select count(*) from t')).stdout.trim() === '1',
            'app_backup cannot read',
          );
          for (const [what, sql] of [
            ['insert', 'insert into t values (2)'],
            ['create', 'create table u(x int)'],
            ['set role', `set role ${names.admin}`],
          ]) {
            assert((await psql(b, sql)).code !== 0, `app_backup was allowed to ${what}`);
          }
          assert(
            (await psql(b, 'begin read write; insert into t values (3); commit')).code !== 0,
            'READ WRITE transaction accepted',
          );
          assert(
            (
              await psql(urlAs(names.admin, pw.admin, names.db), 'select count(*) from t')
            ).stdout.trim() === '1',
            'row count changed',
          );
        },
      );
      await step(
        'roles: drift is repaired (connection limit, inherit); passwords change only on --rotate',
        async () => {
          const d = await admin(`alter role ${role('backup')} connection limit 9 inherit`);
          assert(d.code === 0, `could not drift: ${d.all}`);
          assert((await roles(['verify'])).code === 1, 'verify accepted a drifted app_backup');
          const fix = await roles(['apply']);
          assert(fix.code === 0, `apply did not repair: ${mask(fix.all)}`);
          // The test server may use trust authentication, so compare the stored password hashes (readable by its superuser).
          const hashes = async () =>
            (
              await psql(
                ADMIN_URL,
                `select rolname, md5(rolpassword) from pg_authid where rolname like 'app\\_%\\_${sfx}' order by 1`,
              )
            ).stdout;
          const before = await hashes();
          const noRotate = await roles(['apply'], { PROVISION_PW_BACKUP: 'ignored' + pw.b });
          assert(
            noRotate.code === 0 && (await hashes()) === before,
            'a plain apply changed a password',
          );
          const rot = await roles(['apply', '--rotate'], { PROVISION_PW_BACKUP: 'rotated' + pw.b });
          assert(
            rot.code === 0 && rot.all.includes(`rotated password of ${role('backup')}`),
            'rotation failed',
          );
          const afterLines = (await hashes()).split('\n');
          const changed = before
            .split('\n')
            .filter((l, i) => l !== afterLines[i])
            .map((l) => l.split('|')[0]);
          assert(
            changed.includes(role('backup')),
            'the rotation did not change the app_backup password',
          );
        },
      );
      await step('roles: an elevated existing role is refused, not repaired', async () => {
        await psql(ADMIN_URL, `alter role ${role('worker')} createdb`);
        const r = await roles(['apply']);
        assert(
          r.code === 1 && /elevated attribute/.test(r.all),
          `expected a refusal: ${mask(r.all)}`,
        );
        await psql(ADMIN_URL, `alter role ${role('worker')} nocreatedb`);
      });
      await step('roles: a connection peak the plan cannot hold fails the read-back', async () => {
        const r = await roles(['verify'], { PROVISION_PEAK: '90' });
        assert(
          r.code === 1 && /FAIL max_connections/.test(r.all),
          `expected FAIL max_connections: ${mask(r.all).slice(-200)}`,
        );
      });
      await step(
        'roles: a missing password for a missing role stops before creating anything',
        async () => {
          const r = await roles(['apply'], {
            PROVISION_ROLE_SUFFIX: `${names.suffix}z`,
            PROVISION_PW_API: '',
          });
          assert(
            r.code === 1 && /PROVISION_PW_API is not set/.test(r.all),
            `expected a named missing password: ${mask(r.all)}`,
          );
          const made = await psql(
            ADMIN_URL,
            `select count(*) from pg_roles where rolname like 'app\\_%\\_${sfx}z'`,
          );
          assert(
            made.stdout.trim() === '0',
            'a role was created before the missing password was noticed',
          );
        },
      );
    } finally {
      const drop = async (sql) => psql(ADMIN_URL, sql);
      for (const d of [names.db, names.other]) await drop(`drop database if exists ${d}`);
      await drop(
        `drop role if exists ${['migrator', 'api', 'worker', 'backup'].map(role).join(', ')}`,
      );
      // Roles owning nothing but their grants are gone; the admin last (it created the others).
      await drop(`drop role if exists ${names.admin}`);
      await step('roles: nothing is left on the test server', async () => {
        const left = await psql(
          ADMIN_URL,
          `select (select count(*) from pg_roles where rolname like '%\\_${sfx}') + (select count(*) from pg_database where datname like '%\\_${sfx}')`,
        );
        assert(left.stdout.trim() === '0', `${left.stdout.trim()} object(s) left behind`);
      });
    }
    await step(
      'roles: hosted target without a G3 record is refused; without a connection it is deployment-ready, not deployed',
      async () => {
        const refused = await sh(join(HERE, 'roles.sh'), ['apply'], {
          PROVISION_DATABASE_URL: 'postgres://u:p@dpg-example.render.com/shroomap',
          PROVISION_ENVIRONMENT: 'staging',
          PROVISION_G3_RECORD: '',
          PROVISION_LOCAL: '',
        });
        assert(
          refused.code === 1 && /nothing is created before the G3/.test(refused.all),
          `expected a G3 refusal: ${refused.all}`,
        );
        const wrongEnv = join(mkdtempSync(join(tmpdir(), 'g3-')), 'g3.json');
        writeFileSync(wrongEnv, JSON.stringify({ decision: 'PASS', environment: 'production' }));
        const crossed = await sh(join(HERE, 'roles.sh'), ['apply'], {
          PROVISION_DATABASE_URL: 'postgres://u:p@dpg-example.render.com/shroomap',
          PROVISION_ENVIRONMENT: 'staging',
          PROVISION_G3_RECORD: wrongEnv,
          PROVISION_LOCAL: '',
        });
        assert(
          crossed.code === 1 && /another environment/.test(crossed.all),
          `a production G3 must not authorize staging: ${crossed.all}`,
        );
        const bare = await sh(join(HERE, 'roles.sh'), ['apply'], { PROVISION_DATABASE_URL: '' });
        assert(
          bare.code === 0 && /deployment-ready-not-deployed/.test(bare.all),
          `expected deployment-ready: ${bare.all}`,
        );
        const local = await sh(join(HERE, 'roles.sh'), ['apply'], {
          PROVISION_DATABASE_URL: 'postgres://u:p@dpg-example.render.com/shroomap',
          PROVISION_LOCAL: '1',
          PROVISION_ENVIRONMENT: '',
        });
        assert(
          local.code === 1 && /PROVISION_ENVIRONMENT/.test(local.all),
          'PROVISION_LOCAL must not unlock a hosted host name',
        );
      },
    );
  }
}

// ------------------------------------------------------------------------------------------------ 4 buckets
// A local stand-in of the R2 bucket, lifecycle and lock endpoints (envelope {success, errors, result}).
function standIn() {
  const state = new Map();
  const calls = [];
  const behaviour = { failLock: false, dropLockRule: false };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m =
        /^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets(?:\/([^/]+)(?:\/(lifecycle|lock))?)?$/.exec(
          req.url ?? '',
        );
      const send = (status, result, errors = []) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: status < 300, errors, result }));
      };
      calls.push({ method: req.method, path: req.url, auth: req.headers.authorization });
      if (!m || req.headers.authorization !== 'Bearer admin-token-for-the-test')
        return send(401, null, [{ message: 'unauthorized' }]);
      const [, , bucket, kind] = m;
      if (!bucket && req.method === 'POST') {
        const { name } = JSON.parse(body);
        if (state.has(name)) return send(409, null, [{ message: 'exists' }]);
        state.set(name, { lifecycle: [], lock: [] });
        return send(200, { name });
      }
      const b = state.get(decodeURIComponent(bucket ?? ''));
      if (!b) return send(404, null, [{ code: 10006, message: 'bucket not found' }]);
      if (!kind) return send(200, { name: bucket });
      if (req.method === 'PUT') {
        if (kind === 'lock' && behaviour.failLock)
          return send(500, null, [{ message: 'internal' }]);
        const { rules } = JSON.parse(body);
        b[kind] = kind === 'lock' && behaviour.dropLockRule ? rules.slice(1) : rules;
        return send(200, {});
      }
      return send(200, { rules: b[kind] });
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        server,
        state,
        calls,
        behaviour,
        url: `http://127.0.0.1:${server.address().port}/client/v4`,
      }),
    ),
  );
}

const bucketsCli = (args, env) =>
  sh('node', [join(HERE, 'buckets.mjs'), ...args], {
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_ADMIN_TOKEN: '',
    PROVISION_LOCAL: '',
    PROVISION_G3_RECORD: '',
    ...env,
  });
const si = await standIn();
const cf = {
  CLOUDFLARE_ACCOUNT_ID: 'acct123',
  CLOUDFLARE_ADMIN_TOKEN: 'admin-token-for-the-test',
  CLOUDFLARE_API_URL: si.url,
  PROVISION_LOCAL: '1',
};
try {
  await step(
    'buckets: the plan names three private buckets per environment and the lock and lifecycle rules (SB v6 7.1 C)',
    async (note) => {
      for (const env of ['staging', 'production']) {
        const p = desired(env, 30);
        assert(
          p.buckets.map((b) => b.name).join() ===
            [`app`, `erasure-ledger`, `backup`].map((s) => `shroomap-${env}-${s}`).join(),
          `${env} bucket names`,
        );
        const backup = p.buckets[2];
        const ledger = backup.lock.find((l) => l.prefix === 'ledger/');
        assert(ledger?.condition.type === 'Indefinite', 'ledger/ is not locked indefinitely');
        const age = backup.lock.find((l) => !l.prefix);
        assert(
          age?.condition.type === 'Age' && age.condition.maxAgeSeconds === 30 * 86400,
          'whole-bucket age lock is not the retention',
        );
        const life = backup.lifecycle.map(
          (l) => `${l.conditions.prefix}@${l.deleteObjectsTransition.condition.maxAge / 86400}d`,
        );
        assert(
          life.join() === 'db/@31d,manifests/@31d,media-deleted/@31d',
          `lifecycle: ${life.join()}`,
        );
        assert(
          !backup.lifecycle.some((l) => ['media/', 'ledger/'].includes(l.conditions.prefix)),
          'lifecycle on media/ or ledger/',
        );
      }
      assert(
        desired('staging', 90).buckets[2].lock[1].condition.maxAgeSeconds === 90 * 86400,
        'retention is not configurable',
      );
      assert(
        (() => {
          try {
            desired('staging', 3);
          } catch {
            return true;
          }
        })(),
        'a retention under 7 days was accepted',
      );
      note(
        'lock: ledger/ indefinite, whole bucket age = BACKUP_RETENTION_DAYS; lifecycle: db/, manifests/, media-deleted/ after retention + 1 d; none on media/ or ledger/',
      );
      note(
        'names (staging): shroomap-staging-app, shroomap-staging-erasure-ledger, shroomap-staging-backup; production likewise, never shared',
      );
    },
  );
  await step(
    'buckets: apply creates the buckets and rules, reads them back, and a second apply creates nothing',
    async (note) => {
      const a = await bucketsCli(['apply', '--env', 'staging'], cf);
      assert(a.code === 0 && a.stdout.includes('buckets: apply complete'), `apply: ${a.all}`);
      assert(
        (a.stdout.match(/created bucket/g) ?? []).length === 3,
        'three buckets were not created',
      );
      assert(!a.all.includes(cf.CLOUDFLARE_ADMIN_TOKEN), 'the token appears in the output');
      assert(
        si.state.get('shroomap-staging-backup').lock.length === 2 &&
          si.state.get('shroomap-staging-backup').lifecycle.length === 3,
        'rules not stored',
      );
      const posts = si.calls.filter((c) => c.method === 'POST').length;
      const b = await bucketsCli(['apply', '--env', 'staging'], cf);
      assert(b.code === 0 && !/created bucket/.test(b.stdout), `second apply: ${b.all}`);
      assert(
        si.calls.filter((c) => c.method === 'POST').length === posts,
        'the second apply posted',
      );
      const v = await bucketsCli(['verify', '--env', 'staging'], cf);
      assert(v.code === 0 && (v.stdout.match(/^ok /gm) ?? []).length === 6, `verify: ${v.all}`);
      assert(
        si.calls.every((c) => c.auth === 'Bearer admin-token-for-the-test'),
        'a call without the token',
      );
      note(a.stdout.trim().split('\n').join('\n     '));
      note(`second apply: no bucket created, ${v.stdout.match(/^ok /gm).length} read-backs equal`);
    },
  );
  await step(
    'buckets: verify never writes, finds a missing bucket and a drifted rule',
    async () => {
      const before = si.calls.length;
      await bucketsCli(['verify', '--env', 'staging'], cf);
      assert(
        si.calls.slice(before).every((c) => c.method === 'GET'),
        'verify wrote',
      );
      const missing = await bucketsCli(['verify', '--env', 'production'], cf);
      assert(
        missing.code === 1 && /bucket missing/.test(missing.all),
        `missing bucket: ${missing.all}`,
      );
      si.state.get('shroomap-staging-backup').lock = [];
      const drift = await bucketsCli(['verify', '--env', 'staging'], cf);
      assert(
        drift.code === 1 && /lock rules read back differ/.test(drift.all),
        `drift: ${drift.all}`,
      );
      const fixed = await bucketsCli(['apply', '--env', 'staging'], cf);
      assert(fixed.code === 0, `apply did not repair the drift: ${fixed.all}`);
    },
  );
  await step(
    'buckets: a host that stores fewer rules than asked, or refuses them, fails the run',
    async () => {
      si.behaviour.dropLockRule = true;
      const dropped = await bucketsCli(['apply', '--env', 'staging'], cf);
      si.behaviour.dropLockRule = false;
      assert(
        dropped.code === 1 && /read back differ/.test(dropped.all),
        `silently dropped rule: ${dropped.all}`,
      );
      si.behaviour.failLock = true;
      const refused = await bucketsCli(['apply', '--env', 'staging'], cf);
      si.behaviour.failLock = false;
      assert(refused.code === 1 && /set lock on/.test(refused.all), `host refusal: ${refused.all}`);
      const badToken = await bucketsCli(['verify', '--env', 'staging'], {
        ...cf,
        CLOUDFLARE_ADMIN_TOKEN: 'wrong',
      });
      assert(badToken.code === 1 && !badToken.all.includes('wrong-secret'), 'bad token');
    },
  );
  await step(
    "buckets: hosted apply needs the environment's G3 record; a local flag cannot reach a real host",
    async () => {
      const hosted = {
        CLOUDFLARE_ACCOUNT_ID: 'a',
        CLOUDFLARE_ADMIN_TOKEN: 'secret-admin',
        CLOUDFLARE_API_URL: 'https://api.cloudflare.com/client/v4',
      };
      const none = await bucketsCli(['apply', '--env', 'staging'], hosted);
      assert(
        none.code === 3 && /nothing is created before the G3/.test(none.all),
        `no G3: ${none.all}`,
      );
      const dir = mkdtempSync(join(tmpdir(), 'g3-'));
      const wrong = join(dir, 'g3.json');
      writeFileSync(wrong, JSON.stringify({ decision: 'PASS', environment: 'production' }));
      const crossed = await bucketsCli(['apply', '--env', 'staging', '--g3-record', wrong], hosted);
      assert(crossed.code === 3, `a production G3 authorized staging: ${crossed.all}`);
      const spoof = await bucketsCli(['apply', '--env', 'staging'], {
        ...hosted,
        PROVISION_LOCAL: '1',
      });
      assert(spoof.code === 3, 'PROVISION_LOCAL reached a hosted API URL');
      const plain = await bucketsCli(['apply', '--env', 'staging'], {
        ...hosted,
        CLOUDFLARE_API_URL: 'http://example.com/v4',
      });
      assert(plain.code === 3, 'a non-https URL was accepted');
      rmSync(dir, { recursive: true, force: true });
    },
  );
  await step(
    'buckets: without an account it calls nothing and lists what the owner adds (deployment-ready, not deployed)',
    async () => {
      const before = si.calls.length;
      const r = await bucketsCli(['apply', '--env', 'production'], {});
      assert(
        r.code === 0 &&
          /deployment-ready-not-deployed/.test(r.stdout) &&
          /CLOUDFLARE_ADMIN_TOKEN/.test(r.stdout),
        `got: ${r.all}`,
      );
      assert(si.calls.length === before, 'a call was made');
      const usage = await bucketsCli(['apply', '--env', 'qa'], {});
      assert(usage.code === 2, 'an unknown environment was accepted');
    },
  );
} finally {
  si.server.close();
}

// ------------------------------------------------------------------------------------------------ report
const failed = results.filter((r) => !r.ok);
say('');
say(
  `provision plan check: ${results.length - failed.length} of ${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`,
);
say(
  'no credential was used, no account was contacted and no cloud resource was created; the shared test PostgreSQL held a disposable database and four roles, all dropped',
);
console.log(out.join('\n'));

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? resolve(process.argv[i + 1]) : null;
};
const esc = (s) =>
  String(s).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );
if (arg('--junit')) {
  mkdirSync(dirname(arg('--junit')), { recursive: true });
  const cases = results
    .map(
      (r) =>
        `  <testcase classname="provision" name="${esc(r.name)}" time="${(r.ms / 1000).toFixed(3)}">${r.ok ? '' : `<failure message="${esc(r.message)}"/>`}</testcase>`,
    )
    .join('\n');
  writeFileSync(
    arg('--junit'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n<testsuite name="provision" tests="${results.length}" failures="${failed.length}">\n${cases}\n</testsuite>\n</testsuites>\n`,
  );
}
if (arg('--record')) {
  mkdirSync(dirname(arg('--record')), { recursive: true });
  writeFileSync(arg('--record'), `${out.join('\n').replaceAll(sfx, '<sfx>')}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
