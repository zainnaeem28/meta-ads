#!/usr/bin/env node
// Render Blueprint as code (DO-11, TASK-018; DEVOPS-PLAN 5.1, 6.1, 10.2, 12).
//
//   node scripts/provision/render-blueprint.mjs --write     regenerate infra/render/<env>/render.yaml
//   node scripts/provision/render-blueprint.mjs --check     the files are current and pass every lint rule (no account needed)
//   node scripts/provision/render-blueprint.mjs --probe     inject one defect at a time and prove each is caught
//   --root DIR                                              repository root (default: this repository)
//
// The environment variable lists are derived from config/registry.json (the single source of names and classes), so a
// service can only name a variable that exists in the registry and in .env.example. Names only: no value of a secret
// is written anywhere. Nothing here calls Render; applying the Blueprint is the owner's step (docs/ops/provisioning.md).

import console from 'node:console';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENVIRONMENTS = ['staging', 'production'];
// The registry path of the images. The owner sets PROVISION_IMAGE_PREFIX when regenerating (docs/ops/provisioning.md); the
// release workflow's RELEASE_IMAGE_PREFIX variable must hold the same path.
const imagePrefix = () => process.env.PROVISION_IMAGE_PREFIX || 'ghcr.io/OWNER/REPOSITORY';
const REGION = 'frankfurt'; // owner decision DOP-OI-1 (default: nearest the owner); change here and regenerate
const DB_NAME = 'shroomap';
const PROFILE = {
  staging: {
    db: 'basic-1gb',
    web: 'starter',
    api: 'starter',
    worker: 'standard',
    cron: 'starter',
    pserv: 'starter',
  },
  production: {
    db: 'pro-4gb',
    web: 'standard',
    api: 'standard',
    worker: 'standard',
    cron: 'starter',
    pserv: 'starter',
  },
};
// Public values the Blueprint can fix itself; every other required name is `sync: false` and filled by the owner.
const fixedValue = (name, env) =>
  ({
    APP_ENV: env,
    SENTRY_ENVIRONMENT: env,
    R2_BUCKET: `shroomap-${env}-app`,
    R2_LEDGER_BUCKET: `shroomap-${env}-erasure-ledger`,
    R2_BACKUP_BUCKET: `shroomap-${env}-backup`,
    BACKUP_RETENTION_DAYS: '30',
    API_PORT: '4000',
    WORKER_DRAIN_SECONDS: '90',
  })[name];

// Service name -> registry service, Render type and start command (the image's own CMD is used when absent).
const SERVICES = [
  { name: 'web', registry: 'web', type: 'web', image: 'web', health: '/' },
  { name: 'api', registry: 'api', type: 'web', image: 'api', health: '/health/ready' },
  { name: 'worker', registry: 'worker', type: 'worker', image: 'worker', shutdown: 120 },
  // Dedicated private service the release runs one-off Render Jobs on, with the api image (DEVOPS-PLAN 10.1).
  {
    name: 'migrate',
    registry: 'release',
    type: 'pserv',
    image: 'api',
    command: 'node -e "setInterval(()=>{},3600000)"',
  },
  { name: 'backup', registry: 'backup', type: 'cron', image: 'backup', schedule: '17 2 * * *' },
  {
    name: 'monitor',
    registry: 'monitor',
    type: 'cron',
    image: 'api',
    schedule: '*/5 * * * *',
    command: 'node scripts/monitor/src/main.ts',
  },
];

export function loadRegistry(root) {
  return JSON.parse(readFileSync(join(root, 'config/registry.json'), 'utf8'));
}

export function build(env, registry) {
  const names = (svc) =>
    registry.keys.filter(
      (k) =>
        k.services.includes(svc.registry) &&
        (k.requiredIn.includes(svc.registry) || fixedValue(k.name, env) !== undefined),
    );
  const envVars = (svc) =>
    names(svc).map((k) => {
      const value = k.class === 'secret' ? undefined : fixedValue(k.name, env);
      return value === undefined ? { key: k.name, sync: false } : { key: k.name, value };
    });
  const services = SERVICES.map((svc) => {
    const out = {
      type: svc.type,
      name: `shroomap-${env}-${svc.name}`,
      runtime: 'image',
      image: { url: `${imagePrefix()}/${svc.image}` },
      region: REGION,
      plan: PROFILE[env][svc.type === 'web' ? svc.name : svc.type],
      autoDeployTrigger: 'off',
    };
    if (svc.health) out.healthCheckPath = svc.health;
    if (svc.schedule) out.schedule = svc.schedule;
    if (svc.command) out.dockerCommand = svc.command;
    if (svc.shutdown) out.maxShutdownDelaySeconds = svc.shutdown;
    out.envVars = envVars(svc);
    return out;
  });
  return {
    databases: [
      {
        name: `shroomap-${env}-db`,
        databaseName: DB_NAME,
        user: 'host_admin',
        plan: PROFILE[env].db,
        region: REGION,
        postgresMajorVersion: '17',
        ipAllowList: [],
      },
    ],
    services,
  };
}

// ---------------------------------------------------------------------------------------------------------- YAML
// Block style in the repository's Prettier form (single-quoted strings, lists indented under their key). The reader below parses exactly this subset.
export function toYaml(doc, env) {
  const lines = [
    `# Render Blueprint, ${env}. GENERATED by scripts/provision/render-blueprint.mjs --write from config/registry.json: do not edit.`,
    '# Manual sync only: no service deploys on a push or an image change (autoDeployTrigger: off). Images are deployed by',
    '# digest through the release workflow; the url below names the repository only. Secrets are `sync: false`: the owner sets them',
    '# in the Render dashboard (docs/ops/provisioning.md), never in this file. The registry path is PROVISION_IMAGE_PREFIX at generation.',
  ];
  const scalar = (v) =>
    typeof v === 'string' ? `'${v.replaceAll("'", "''")}'` : JSON.stringify(v);
  const emit = (value, indent) => {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      for (const item of value) {
        if (item && typeof item === 'object') {
          const entries = Object.entries(item);
          entries.forEach(([k, v], i) => emitEntry(k, v, indent + 2, i === 0 ? `${pad}- ` : null));
        } else lines.push(`${pad}- ${scalar(item)}`);
      }
    }
  };
  const emitEntry = (key, value, indent, lead) => {
    const prefix = lead ?? ' '.repeat(indent);
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${prefix}${key}: []`);
      else {
        lines.push(`${prefix}${key}:`);
        emit(value, indent + 2);
      }
    } else if (value && typeof value === 'object') {
      lines.push(`${prefix}${key}:`);
      for (const [k, v] of Object.entries(value)) emitEntry(k, v, indent + 2, null);
    } else lines.push(`${prefix}${key}: ${scalar(value)}`);
  };
  for (const [k, v] of Object.entries(doc)) emitEntry(k, v, 0, null);
  return `${lines.join('\n')}\n`;
}

export function parseYaml(text) {
  const rows = text
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  const value = (s) =>
    s === '[]' ? [] : s.startsWith("'") ? s.slice(1, -1).replaceAll("''", "'") : JSON.parse(s);
  let at = 0;
  const parseBlock = (indent) => {
    if (rows[at].text.startsWith('- ')) {
      const list = [];
      while (at < rows.length && rows[at].indent === indent && rows[at].text.startsWith('- ')) {
        const row = rows[at];
        row.text = row.text.slice(2);
        row.indent += 2;
        list.push(
          row.text.includes(': ') || row.text.endsWith(':')
            ? parseMap(row.indent)
            : value(row.text),
        );
        if (!(row.text.includes(': ') || row.text.endsWith(':'))) at += 1;
      }
      return list;
    }
    return parseMap(indent);
  };
  const parseMap = (indent) => {
    const map = {};
    while (at < rows.length && rows[at].indent === indent && !rows[at].text.startsWith('- ')) {
      const m = /^([A-Za-z0-9_]+):(?: (.*))?$/.exec(rows[at].text);
      if (!m) throw new Error(`cannot parse line: ${rows[at].text}`);
      at += 1;
      if (m[2] !== undefined) map[m[1]] = value(m[2]);
      else if (
        at < rows.length &&
        (rows[at].indent > indent || (rows[at].indent === indent && rows[at].text.startsWith('- ')))
      )
        map[m[1]] = parseBlock(rows[at].indent);
      else map[m[1]] = null;
    }
    return map;
  };
  const doc = parseBlock(0);
  if (at !== rows.length) throw new Error(`unparsed content at line: ${rows[at].text}`);
  return doc;
}

// ---------------------------------------------------------------------------------------------------------- lint
const TYPES = new Set(['web', 'worker', 'cron', 'pserv']);
const SERVICE_KEYS = new Set([
  'type',
  'name',
  'runtime',
  'image',
  'region',
  'plan',
  'autoDeployTrigger',
  'healthCheckPath',
  'schedule',
  'dockerCommand',
  'maxShutdownDelaySeconds',
  'envVars',
]);
const DB_KEYS = new Set([
  'name',
  'databaseName',
  'user',
  'plan',
  'region',
  'postgresMajorVersion',
  'ipAllowList',
]);

export function lint(doc, env, registry, envExample) {
  const errors = [];
  const bad = (m) => errors.push(m);
  const byName = new Map(registry.keys.map((k) => [k.name, k]));
  const allowedTop = new Set(['databases', 'services']);
  for (const k of Object.keys(doc)) if (!allowedTop.has(k)) bad(`unknown top-level key: ${k}`);
  if (!Array.isArray(doc.databases) || doc.databases.length !== 1)
    bad('exactly one database is expected');
  for (const db of doc.databases ?? []) {
    for (const k of Object.keys(db)) if (!DB_KEYS.has(k)) bad(`database: unknown key ${k}`);
    if (!Array.isArray(db.ipAllowList) || db.ipAllowList.length !== 0)
      bad(`database ${db.name}: ipAllowList must be empty (internal access only, DEVOPS-PLAN 5.1)`);
    if (/free|starter/.test(db.plan ?? 'free'))
      bad(`database ${db.name}: a paid tier is required (plan ${db.plan})`);
    if (!['16', '17'].includes(db.postgresMajorVersion))
      bad(`database ${db.name}: PostgreSQL 16 or 17 only`);
    if (!db.name?.includes(env))
      bad(`database ${db.name}: name does not carry the environment ${env}`);
  }
  const seen = new Set();
  const required = new Map(SERVICES.map((s) => [`shroomap-${env}-${s.name}`, s]));
  for (const svc of doc.services ?? []) {
    const id = svc.name ?? '(unnamed)';
    if (seen.has(id)) bad(`${id}: duplicate service`);
    seen.add(id);
    for (const k of Object.keys(svc)) if (!SERVICE_KEYS.has(k)) bad(`${id}: unknown key ${k}`);
    if (!TYPES.has(svc.type)) bad(`${id}: type ${svc.type} is not one of ${[...TYPES].join(', ')}`);
    if (svc.runtime !== 'image') bad(`${id}: runtime must be image (deploy by digest, ADR-005)`);
    if (svc.autoDeployTrigger !== 'off')
      bad(`${id}: autoDeployTrigger must be off (a push or an image change must not deploy)`);
    if (!svc.name?.startsWith(`shroomap-${env}-`))
      bad(`${id}: name does not carry the environment ${env} (environments never cross)`);
    if (svc.image?.url?.includes('@') || svc.image?.url?.includes(':latest'))
      bad(`${id}: image url must name the repository only; a digest is chosen by the release`);
    if (svc.type === 'cron' && !/^\S+ \S+ \S+ \S+ \S+$/.test(svc.schedule ?? ''))
      bad(`${id}: cron needs a five-field schedule`);
    if (svc.type !== 'cron' && svc.schedule) bad(`${id}: only a cron job has a schedule`);
    if (svc.type === 'web' && !svc.healthCheckPath)
      bad(`${id}: a web service needs healthCheckPath (zero-downtime deploy)`);
    if (svc.type !== 'web' && svc.healthCheckPath)
      bad(`${id}: ${svc.type} has no inbound port and no health check path`);
    if (svc.type === 'worker' && !(svc.maxShutdownDelaySeconds >= 90))
      bad(`${id}: worker needs a shutdown delay above its drain deadline (90 s)`);
    const spec = required.get(id);
    if (!spec) bad(`${id}: not a service of the topology (DEVOPS-PLAN 5.1)`);
    for (const ev of svc.envVars ?? []) {
      const key = byName.get(ev.key);
      if (!key) {
        bad(`${id}: ${ev.key} is not in config/registry.json`);
        continue;
      }
      if (!envExample.has(ev.key)) bad(`${id}: ${ev.key} is not in .env.example`);
      if (spec && !key.services.includes(spec.registry))
        bad(`${id}: ${ev.key} is not a variable of the ${spec.registry} process`);
      if (key.class === 'secret' && (ev.sync !== false || 'value' in ev))
        bad(`${id}: secret ${ev.key} must be sync: false, never a value`);
      if (key.class === 'public' && 'value' in ev && 'sync' in ev)
        bad(`${id}: ${ev.key} has both value and sync`);
      if (spec && key.services.includes(spec.registry) === false) continue;
    }
    if (spec) {
      const have = new Set((svc.envVars ?? []).map((e) => e.key));
      for (const k of registry.keys)
        if (k.requiredIn.includes(spec.registry) && !have.has(k.name))
          bad(`${id}: required ${k.name} is missing`);
      for (const f of registry.backupForbidden ?? [])
        if (spec.registry === 'backup' && have.has(f))
          bad(`${id}: forbidden variable ${f} on the backup service`);
      if (spec.registry === 'backup' && have.has('DATABASE_URL'))
        bad(`${id}: backup must not hold DATABASE_URL`);
      if (
        spec.registry === 'release' &&
        [...have].some((n) => n !== 'MIGRATION_DATABASE_URL' && byName.get(n)?.class === 'secret')
      )
        bad(`${id}: the migrate service holds only the migrator database URL`);
    }
  }
  for (const id of required.keys()) if (!seen.has(id)) bad(`${id}: service missing`);
  const appEnv = (doc.services ?? []).flatMap((s) =>
    (s.envVars ?? []).filter((e) => e.key === 'APP_ENV').map((e) => e.value),
  );
  if (appEnv.some((v) => v !== env)) bad(`APP_ENV must be ${env} on every service`);
  return errors;
}

function loadEnvExample(root) {
  const names = new Set();
  for (const line of readFileSync(join(root, '.env.example'), 'utf8').split('\n')) {
    const m = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

export function fileFor(root, env) {
  return join(root, 'infra/render', env, 'render.yaml');
}

export function check(root) {
  const registry = loadRegistry(root);
  const envExample = loadEnvExample(root);
  const errors = [];
  const summary = [];
  for (const env of ENVIRONMENTS) {
    const file = fileFor(root, env);
    if (!existsSync(file)) {
      errors.push(`${file}: missing (run --write)`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const expected = toYaml(build(env, registry), env);
    if (text !== expected)
      errors.push(
        `infra/render/${env}/render.yaml is not current: run node scripts/provision/render-blueprint.mjs --write`,
      );
    let doc;
    try {
      doc = parseYaml(text);
    } catch (e) {
      errors.push(`infra/render/${env}/render.yaml: ${e.message}`);
      continue;
    }
    for (const m of lint(doc, env, registry, envExample)) errors.push(`${env}: ${m}`);
    const vars = doc.services.reduce((n, s) => n + s.envVars.length, 0);
    summary.push(
      `${env}: ${doc.services.length} services, 1 database, ${vars} variable names, ${doc.services.flatMap((s) => s.envVars).filter((e) => e.sync === false).length} left to the owner`,
    );
  }
  return { errors, summary };
}

// One defect at a time, each must be caught by the lint.
export function probe(root) {
  const registry = loadRegistry(root);
  const envExample = loadEnvExample(root);
  const env = 'staging';
  const clean = () => JSON.parse(JSON.stringify(build(env, registry)));
  const svc = (d, n) => d.services.find((s) => s.name.endsWith(`-${n}`));
  const cases = {
    'auto deploy on': (d) => (svc(d, 'api').autoDeployTrigger = 'commit'),
    'secret with a value': (d) =>
      (svc(d, 'api').envVars.find((e) => e.key === 'CLERK_SECRET_KEY').value = 'x'),
    'unknown variable': (d) => svc(d, 'api').envVars.push({ key: 'NOT_IN_REGISTRY', sync: false }),
    'forbidden variable on backup': (d) =>
      svc(d, 'backup').envVars.push({ key: 'KEK_PRIVATE_KEYS', sync: false }),
    'database URL on backup': (d) =>
      svc(d, 'backup').envVars.push({ key: 'DATABASE_URL', sync: false }),
    'open database allow list': (d) => (d.databases[0].ipAllowList = [{ source: '0.0.0.0/0' }]),
    'free database': (d) => (d.databases[0].plan = 'free'),
    'worker health check': (d) => (svc(d, 'worker').healthCheckPath = '/'),
    'web without health check': (d) => delete svc(d, 'web').healthCheckPath,
    'image by tag latest': (d) => (svc(d, 'api').image.url += ':latest'),
    'other environment name': (d) => (svc(d, 'api').name = 'shroomap-production-api'),
    'missing service': (d) => (d.services = d.services.filter((s) => !s.name.endsWith('-worker'))),
    'missing required variable': (d) =>
      (svc(d, 'api').envVars = svc(d, 'api').envVars.filter((e) => e.key !== 'DATABASE_URL')),
    'wrong APP_ENV': (d) =>
      (svc(d, 'api').envVars.find((e) => e.key === 'APP_ENV').value = 'production'),
    'unknown service key': (d) => (svc(d, 'api').autoDeploy = false),
  };
  const results = [];
  for (const [name, mutate] of Object.entries(cases)) {
    const doc = clean();
    mutate(doc);
    const caught = lint(parseYaml(toYaml(doc, env)), env, registry, envExample);
    results.push({ name, caught: caught.length > 0, first: caught[0] });
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? resolve(args[rootIdx + 1]) : resolve(HERE, '../..');
  if (args.includes('--write')) {
    const registry = loadRegistry(root);
    for (const env of ENVIRONMENTS) {
      const file = fileFor(root, env);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, toYaml(build(env, registry), env));
      console.log(`wrote ${file.replace(`${root}/`, '')}`);
    }
    return 0;
  }
  if (args.includes('--probe')) {
    const results = probe(root);
    for (const r of results)
      console.log(`${r.caught ? 'caught' : 'MISSED'}  ${r.name}${r.first ? `  (${r.first})` : ''}`);
    return results.every((r) => r.caught) ? 0 : 1;
  }
  const { errors, summary } = check(root);
  for (const s of summary) console.log(s);
  for (const e of errors) console.error(`FAIL ${e}`);
  console.log(
    errors.length === 0
      ? 'render blueprint: clean'
      : `render blueprint: ${errors.length} problem(s)`,
  );
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main());
