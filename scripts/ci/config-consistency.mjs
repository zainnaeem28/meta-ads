#!/usr/bin/env node
// Configuration consistency (DO-05, TASK-009).
//
//   node scripts/ci/config-consistency.mjs                check (default): registry.json against schema.ts, .env.example,
//                                                          docs/ops/secrets.md and the container definitions
//   node scripts/ci/config-consistency.mjs --write         regenerate .env.example and docs/ops/secrets.md
//   node scripts/ci/config-consistency.mjs --probe         inject one mismatch at a time and prove each is caught
//   node scripts/ci/config-consistency.mjs --local-env DIR write one env file per process with throwaway local
//                                                          key material (never committed; DIR is git-ignored)
//   --root DIR                                             repository root (default: this repository)
//
// config/registry.json is the single source. The Zod schema (apps/api/src/platform/config/registry.ts) must agree on
// every name, class, requirement and default of the keys it reads. Output names keys only, never a value.

import console from 'node:console';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const clone = (value) => JSON.parse(JSON.stringify(value));
const SCHEMA_PROCESSES = ['api', 'worker', 'release'];
const SERVICES = ['api', 'worker', 'release', 'web', 'backup', 'monitor'];
const HOSTED = ['staging', 'production'];
const PATHS = {
  registry: 'config/registry.json',
  schema: 'apps/api/src/platform/config/registry.ts',
  vendors: 'apps/api/src/platform/config/compliance-register.ts',
  envExample: '.env.example',
  secretsDoc: 'docs/ops/secrets.md',
};

// ---------------------------------------------------------------------------------------------------------------
// Schema side: read registry.ts as text (it is TypeScript; the script must run before any build).

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function callArguments(text, openIndex) {
  let depth = 0;
  let quote = '';
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return splitTopLevel(text.slice(openIndex + 1, i));
  }
  throw new Error('unbalanced call in the schema registry');
}

export function parseSchema(registryTs, vendorsTs) {
  const sets = {
    ALL: ['api', 'worker', 'release'],
    A: ['api'],
    AW: ['api', 'worker'],
    W: ['worker'],
    R: ['release'],
  };
  const body = registryTs.slice(registryTs.indexOf('export const REGISTRY = {'));
  const end = body.indexOf('} as const satisfies');
  if (end < 0) throw new Error('REGISTRY block not found in the schema registry');
  const block = body.slice(0, end);
  const keys = new Map();
  const entry = /^ {2}([A-Z][A-Z0-9_]*): (pub|secret)\(/gm;
  for (let m = entry.exec(block); m; m = entry.exec(block)) {
    const args = callArguments(block, m.index + m[0].length - 1);
    const rest = args[2] ?? '';
    const required = /requiredIn:\s*(\w+)/.exec(rest);
    const dflt = /default:\s*'((?:[^'\\]|\\.)*)'/.exec(rest);
    keys.set(m[1], {
      class: m[2] === 'secret' ? 'secret' : 'public',
      processes: sets[args[1]] ?? null,
      requiredIn: required ? (sets[required[1]] ?? null) : [],
      default: dflt ? dflt[1].replace(/\\(.)/g, '$1') : null,
    });
  }
  const vendors = /PROVIDER_VENDORS = \[([^\]]*)\]/.exec(vendorsTs);
  if (!vendors) throw new Error('PROVIDER_VENDORS not found');
  for (const vendor of [...vendors[1].matchAll(/'([A-Z0-9_]+)'/g)].map((v) => v[1])) {
    keys.set(`PROVIDER_DATA_MODE_${vendor}`, {
      class: 'public',
      processes: ['worker'],
      requiredIn: [],
      default: 'synthetic',
    });
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------------------------
// Checks. Every check returns problems as strings that name keys and files, never values.

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const inSchemaScope = (list) => list.filter((s) => SCHEMA_PROCESSES.includes(s));

export function checkRegistry(reg) {
  const problems = [];
  const seen = new Set();
  for (const key of reg.keys) {
    const at = `registry.json ${key.name}`;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key.name ?? '')) problems.push(`${at}: invalid name`);
    if (seen.has(key.name)) problems.push(`${at}: duplicate name`);
    seen.add(key.name);
    if (!['public', 'secret'].includes(key.class))
      problems.push(`${at}: class must be public or secret`);
    if (
      !Array.isArray(key.services) ||
      key.services.length === 0 ||
      key.services.some((s) => !SERVICES.includes(s))
    )
      problems.push(`${at}: services must be a non-empty subset of ${SERVICES.join(', ')}`);
    if ((key.requiredIn ?? []).some((s) => !key.services?.includes(s)))
      problems.push(`${at}: requiredIn names a service that does not read the key`);
    if (key.class === 'secret' && key.default != null)
      problems.push(`${at}: a secret never has a registry default`);
    if (key.class === 'secret' && !key.store)
      problems.push(`${at}: a secret needs its store and rotation owner`);
    if (!key.local || !(key.local.value !== undefined || key.local.generate || key.local.unset))
      problems.push(`${at}: local must give a value, generate or unset`);
    if (!/^(schema|pending:TASK-\d+|n\/a)$/.test(key.schema ?? ''))
      problems.push(`${at}: schema must be schema, pending:TASK-n or n/a`);
    if (key.refusedIn?.some((e) => !HOSTED.includes(e)))
      problems.push(`${at}: refusedIn lists hosted environments only`);
    if (key.refusedIn && key.local?.value === undefined)
      problems.push(`${at}: a local-mode key needs a local default`);
  }
  return problems;
}

export function checkSchema(reg, schema) {
  const problems = [];
  const byName = new Map(reg.keys.map((k) => [k.name, k]));
  for (const [name, def] of schema) {
    const key = byName.get(name);
    if (!key) {
      problems.push(`${name}: in schema.ts but missing from registry.json`);
      continue;
    }
    if (key.class !== def.class)
      problems.push(
        `${name}: class is ${key.class} in registry.json and ${def.class} in schema.ts`,
      );
    if (!sameSet(inSchemaScope(key.services), def.processes))
      problems.push(
        `${name}: processes differ (registry.json ${inSchemaScope(key.services).join('/') || 'none'}, schema.ts ${def.processes.join('/')})`,
      );
    if (!sameSet(inSchemaScope(key.requiredIn ?? []), def.requiredIn))
      problems.push(
        `${name}: requirement differs (registry.json ${inSchemaScope(key.requiredIn ?? []).join('/') || 'none'}, schema.ts ${def.requiredIn.join('/') || 'none'})`,
      );
    if ((key.default ?? null) !== def.default)
      problems.push(`${name}: default differs between registry.json and schema.ts`);
    if (key.schema !== 'schema')
      problems.push(
        `${name}: schema.ts reads it, so registry.json must say schema (not ${key.schema})`,
      );
  }
  for (const key of reg.keys) {
    if (schema.has(key.name)) continue;
    if (key.schema === 'schema')
      problems.push(`${key.name}: registry.json says schema.ts defines it, but schema.ts does not`);
    if (key.schema === 'n/a' && inSchemaScope(key.services).length > 0)
      problems.push(
        `${key.name}: read by ${inSchemaScope(key.services).join('/')} but absent from schema.ts (use pending:TASK-n with its ticket)`,
      );
  }
  return problems;
}

/** Secrets each service may hold, and the names it may never hold. */
export function secretSets(reg) {
  const sets = {};
  for (const service of SERVICES)
    sets[service] = reg.keys
      .filter((k) => k.class === 'secret' && k.services.includes(service))
      .map((k) => k.name);
  return sets;
}

export function forbiddenFor(reg, service) {
  const allowed = new Set(secretSets(reg)[service]);
  const names = reg.keys
    .filter((k) => k.class === 'secret' && !allowed.has(k.name))
    .map((k) => k.name);
  const extra = reg.forbiddenElsewhere.map((e) => e.name);
  const backupOnly =
    service === 'backup' ? reg.backupForbidden.filter((n) => !names.includes(n)) : [];
  return [...new Set([...names, ...extra, ...backupOnly])];
}

const matchesName = (pattern, name) =>
  pattern.includes('*')
    ? new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(name)
    : pattern === name;
const isForbidden = (reg, service, name) =>
  forbiddenFor(reg, service).some((p) => matchesName(p, name));

export function checkForbidden(reg) {
  const problems = [];
  const backupSecrets = secretSets(reg).backup;
  for (const name of reg.backupForbidden) {
    const holder = reg.keys.find((k) => k.name === name && k.services.includes('backup'));
    if (holder)
      problems.push(
        `${name}: on the backup forbidden list but registry.json gives it to the backup service`,
      );
  }
  for (const key of reg.keys) {
    if (
      key.name.startsWith('KEK_') &&
      key.class === 'secret' &&
      key.services.some((s) => s !== 'worker')
    )
      problems.push(`${key.name}: the KEK private material belongs to the worker alone`);
    if (/AGE.*(PRIVATE|SECRET|IDENTITY)/.test(key.name))
      problems.push(`${key.name}: the age private key is never a runtime variable`);
  }
  const required = [
    'KEK_PRIVATE_KEYS',
    'KEK_V*',
    'KEY_FINGERPRINT_PEPPERS',
    'HMAC_PEPPER',
    'DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_LEDGER_ACCESS_KEY_ID',
    'R2_LEDGER_SECRET_ACCESS_KEY',
    'CLERK_SECRET_KEY',
    'CURSOR_SIGNING_KEY',
    'RATE_LIMIT_IP_KEY',
    'METRICS_TOKEN',
    'SHOTSTACK_API_KEY',
    'RENDER_API_KEY',
    'GHCR_PULL_TOKEN',
    'SENTRY_AUTH_TOKEN',
    'GITHUB_TOKEN',
  ];
  for (const name of required)
    if (!reg.backupForbidden.includes(name))
      problems.push(`${name}: missing from backupForbidden (SB v6 section 7.1 D)`);
  for (const name of ['AGE_SECRET_KEY', 'AGE_PRIVATE_KEY', 'BACKUP_AGE_IDENTITY'])
    if (!reg.backupForbidden.includes(name))
      problems.push(`${name}: the age private key must be on the backupForbidden list`);
  for (const name of backupSecrets)
    if (reg.backupForbidden.some((p) => matchesName(p, name)))
      problems.push(`${name}: held by backup and forbidden there`);
  // The web image holds no server secret except the Clerk middleware key; api and worker hold no other's set.
  for (const service of ['api', 'worker', 'web']) {
    for (const name of secretSets(reg)[service]) {
      const key = reg.keys.find((k) => k.name === name);
      if (key.services.includes('backup') && name !== 'R2_ENDPOINT')
        problems.push(`${name}: shared with the backup service`);
    }
  }
  return problems;
}

/** Names set by a container definition per service. Dockerfile: ENV/ARG per build target. Compose: environment keys per service. */
export function containerEnvNames(text, kind) {
  const found = [];
  const lines = text.split(/\r?\n/);
  if (kind === 'dockerfile') {
    let target = '';
    for (const line of lines) {
      const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
      if (from) target = from[1] ?? '';
      const set = /^(?:ENV|ARG)\s+(.+)$/i.exec(line);
      if (!set || !target) continue;
      for (const pair of set[1].split(/\s+/)) {
        const name = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(pair)?.[1];
        if (name) found.push({ service: target, name });
      }
    }
    return found;
  }
  let service = '';
  let inServices = false;
  let inEnv = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) inServices = true;
    else if (/^\S/.test(line)) inServices = false;
    const head = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (inServices && head) {
      service = head[1];
      inEnv = false;
    }
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) inEnv = false;
    if (inEnv && service) {
      const name = /^\s+(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/.exec(line)?.[1];
      if (name) found.push({ service, name });
    }
  }
  return found;
}

export function checkContainers(reg, files) {
  const problems = [];
  for (const { file, text } of files) {
    const kind = /Dockerfile/.test(file) ? 'dockerfile' : 'compose';
    for (const { service, name } of containerEnvNames(text, kind)) {
      if (!SERVICES.includes(service)) continue;
      if (isForbidden(reg, service, name))
        problems.push(
          `${file}: the ${service} image or service sets ${name}, which it must not hold`,
        );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Generated files.

const GROUP_ORDER = [
  'Platform',
  'Database',
  'Identity',
  'Provider keys',
  'Storage',
  'Limits and caps',
  'Jobs and provider calls',
  'Providers and models',
  'Lifecycle',
  'Observability',
  'Web build',
  'Backup',
  'Local mode',
];

function byGroup(reg) {
  const groups = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const key of reg.keys) {
    if (!groups.has(key.group)) groups.set(key.group, []);
    groups.get(key.group).push(key);
  }
  return [...groups].filter(([, list]) => list.length > 0);
}

const list = (items) => (items.length ? items.join(', ') : 'none');

export function renderEnvExample(reg) {
  const out = [
    '# Generated from config/registry.json by `node scripts/ci/config-consistency.mjs --write`. Do not edit by hand.',
    '# Names, classes and harmless local defaults only. Every value below is a local default for docker/compose.dev.yml;',
    '# nothing here is a real credential. Real values live in the host secret store (docs/ops/secrets.md).',
    '# Each process reads only its own keys and refuses a secret it must not hold, so split this file per process with',
    '#   node scripts/ci/config-consistency.mjs --local-env .env.local.d',
    '# which also generates the throwaway key material marked "generated". `.env.local.d` is git-ignored.',
    '# A line starting with "# NAME=" is an optional key that is unset locally.',
    '',
  ];
  for (const [group, keys] of byGroup(reg)) {
    out.push(`# --- ${group} ---`);
    for (const key of keys) {
      const need = key.requiredIn?.length ? `required in ${key.requiredIn.join(', ')}` : 'optional';
      out.push(
        `# ${key.name}: ${key.class}; read by ${key.services.join(', ')}; ${need}. ${key.validation}`,
      );
      if (key.refusedIn) out.push(`#   Refused when APP_ENV is ${key.refusedIn.join(' or ')}.`);
      const l = key.local;
      if (l.value !== undefined) out.push(`${key.name}=${l.value}`);
      else if (l.generate) out.push(`${key.name}=`, `#   generated by --local-env: ${l.generate}`);
      else out.push(`# ${key.name}=`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export function renderSecretsDoc(reg) {
  const out = [
    '# Secret names and per-process secret sets',
    '',
    'Generated from `config/registry.json` by `node scripts/ci/config-consistency.mjs --write`; edit the registry, not this file.',
    'Names only: no value appears here or anywhere in the repository. Rotation procedures: `docs/ops/secret-rotation.md`.',
    '',
    '## Where a name lives',
    '',
    `Each secret is stored under the name \`${reg.secretNamePattern}\` in the host secret store of its environment (${reg.environments.join(', ')}).`,
    'Deployment credentials are never repository secrets. `pull_request` runs receive none of these.',
    '',
    '## Per-process secret sets',
    '',
    'A process holds exactly its set. Startup refuses (exit 78, naming the key) any secret outside it.',
    '',
    '| Service | Secrets it holds |',
    '| --- | --- |',
  ];
  const sets = secretSets(reg);
  for (const service of SERVICES)
    out.push(
      `| \`${service}\` | ${sets[service].length ? sets[service].map((n) => `\`${n}\``).join(', ') : 'none'} |`,
    );
  out.push(
    '',
    '## Secret-name map',
    '',
    '| Key | Class | Held by | Store | Owner | Rotation |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const key of reg.keys.filter((k) => k.class === 'secret')) {
    out.push(
      `| \`${key.name}\` | secret | ${key.services.join(', ')} | ${key.store} | ${key.owner} | ${key.rotation} |`,
    );
  }
  out.push(
    '',
    '### Name per environment',
    '',
    `| Key | ${reg.environments.map((e) => `\`${e}\``).join(' | ')} |`,
    `| --- | ${reg.environments.map(() => '---').join(' | ')} |`,
  );
  for (const key of reg.keys.filter((k) => k.class === 'secret')) {
    const names = reg.environments.map(
      (env) =>
        `\`${reg.secretNamePattern.replace('<env>', env).replace('<service>', key.services[0]).replace('<KEY>', key.name)}\``,
    );
    out.push(`| \`${key.name}\` | ${names.join(' | ')} |`);
  }
  out.push(
    '',
    '## Forbidden variables per service',
    '',
    'The container checks fail when an image or service definition sets one of these for the service.',
    '',
  );
  for (const service of ['api', 'worker', 'web', 'backup']) {
    const names = forbiddenFor(reg, service);
    out.push(`- **${service}** must not hold: ${names.map((n) => `\`${n}\``).join(', ')}.`);
  }
  out.push(
    '',
    'The `backup` image never holds the KEK (any `KEK_*`) or the age private key (`AGE_SECRET_KEY`, `AGE_PRIVATE_KEY`, `BACKUP_AGE_IDENTITY`); it holds the public recipient only.',
  );
  out.push(
    '',
    '## Variables that are not secrets',
    '',
    '| Key | Read by | Required in | Default |',
    '| --- | --- | --- | --- |',
  );
  for (const key of reg.keys.filter((k) => k.class === 'public'))
    out.push(
      `| \`${key.name}\` | ${key.services.join(', ')} | ${list(key.requiredIn ?? [])} | ${key.default != null ? `\`${key.default}\`` : 'none'} |`,
    );
  return `${out.join('\n')}\n`;
}

// Prettier pads table cells; the comparison ignores padding so the committed file can be prettier-clean.
const normalizeTables = (text) =>
  text
    .split('\n')
    .map((line) => (line.startsWith('|') ? line.replace(/\s+/g, ' ').replace(/-{2,}/g, '-') : line))
    .join('\n');

export function checkGenerated(reg, files) {
  const problems = [];
  const example = files.envExample ?? '';
  for (const key of reg.keys) {
    if (!new RegExp(`^#?\\s*${key.name}=`, 'm').test(example))
      problems.push(`.env.example: ${key.name} is not documented`);
    else if (key.local.value !== undefined && !new RegExp(`^${key.name}=`, 'm').test(example))
      problems.push(`.env.example: ${key.name} has a local default in the registry but is not set`);
  }
  for (const m of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm))
    if (!reg.keys.some((k) => k.name === m[1]))
      problems.push(`.env.example: ${m[1]} is not in registry.json`);
  if (example !== renderEnvExample(reg))
    problems.push('.env.example: differs from the registry output (run with --write)');
  if (normalizeTables(files.secretsDoc ?? '') !== normalizeTables(renderSecretsDoc(reg)))
    problems.push('docs/ops/secrets.md: differs from the registry output (run with --write)');
  const values = parseEnv(example);
  const appEnv = values.APP_ENV;
  for (const key of reg.keys.filter((k) => k.refusedIn)) {
    if (values[key.name] !== 'local')
      problems.push(`.env.example: ${key.name} must default to local`);
    if (appEnv !== 'development')
      problems.push(
        `.env.example: ${key.name} is local-mode, so APP_ENV must default to development`,
      );
  }
  for (const key of reg.keys.filter((k) => k.class === 'secret')) {
    const v = values[key.name];
    if (v !== undefined && v !== '' && key.local.value === undefined)
      problems.push(`.env.example: ${key.name} has a value without a registry local default`);
  }
  return problems;
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Local environment: one file per process, from the example defaults plus throwaway generated key material.

function generated(key, kind) {
  const b64 = (n) => randomBytes(n).toString('base64');
  switch (kind) {
    case 'rsa3072': {
      const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
      return {
        public: JSON.stringify({
          1: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        }),
        private: JSON.stringify({
          1: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }),
      };
    }
    case 'pepper':
      return JSON.stringify({ 1: b64(32) });
    default:
      return randomBytes(32).toString('base64url');
  }
}

export function localEnvFiles(reg) {
  const rsa = generated('KEK', 'rsa3072');
  const values = {};
  for (const key of reg.keys) {
    const l = key.local;
    if (l.value !== undefined) values[key.name] = l.value;
    else if (l.generate === 'rsa3072-public') values[key.name] = rsa.public;
    else if (l.generate === 'rsa3072-private') values[key.name] = rsa.private;
    else if (l.generate === 'pepper-map') values[key.name] = generated(key.name, 'pepper');
    else if (l.generate) values[key.name] = generated(key.name, 'random');
  }
  const files = {};
  for (const service of SERVICES) {
    const lines = [];
    for (const key of reg.keys) {
      if (!key.services.includes(service) || values[key.name] === undefined) continue;
      lines.push(`${key.name}=${values[key.name]}`);
    }
    files[`${service}.env`] = `${lines.join('\n')}\n`;
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------------
// Probes: one injected mismatch at a time, each of which must be reported.

export function probes(reg, schema) {
  const copy = () => clone(reg);
  const find = (r, name) => r.keys.find((k) => k.name === name);
  const cases = [];
  const add = (name, mutate, check, expect) => cases.push({ name, mutate, check, expect });
  const schemaCheck = (r, s) => checkSchema(r, s);
  add(
    'renamed key',
    (r) => void (find(r, 'API_PORT').name = 'API_PORTS'),
    schemaCheck,
    'API_PORT: in schema.ts but missing',
  );
  add(
    'class flipped to secret',
    (r) => void (find(r, 'LOG_LEVEL').class = 'secret'),
    schemaCheck,
    'LOG_LEVEL: class is secret',
  );
  add(
    'requirement dropped',
    (r) => void (find(r, 'WEB_ORIGIN').requiredIn = []),
    schemaCheck,
    'WEB_ORIGIN: requirement differs',
  );
  add(
    'process dropped',
    (r) => void (find(r, 'CURSOR_SIGNING_KEY').services = ['worker']),
    schemaCheck,
    'CURSOR_SIGNING_KEY: processes differ',
  );
  add(
    'default changed',
    (r) => void (find(r, 'API_PORT').default = '4001'),
    schemaCheck,
    'API_PORT: default differs',
  );
  add(
    'key only in the registry marked schema',
    (r) => void r.keys.push({ ...clone(find(r, 'API_PORT')), name: 'EXTRA_KEY' }),
    schemaCheck,
    'EXTRA_KEY: registry.json says schema.ts defines it',
  );
  add(
    'key read by api but unknown to the schema',
    (r) =>
      void r.keys.push({
        ...clone(find(r, 'API_PORT')),
        name: 'EXTRA_KEY',
        schema: 'n/a',
      }),
    schemaCheck,
    'EXTRA_KEY: read by api but absent',
  );
  add(
    'key missing from the registry',
    (r) => void (r.keys = r.keys.filter((k) => k.name !== 'RELEASE_SHA')),
    schemaCheck,
    'RELEASE_SHA: in schema.ts but missing',
  );
  add(
    'KEK private key given to the api',
    (r) => void find(r, 'KEK_PRIVATE_KEYS').services.push('api'),
    (r) => checkForbidden(r),
    'KEK_PRIVATE_KEYS: the KEK private material',
  );
  add(
    'database url given to backup',
    (r) => void find(r, 'DATABASE_URL').services.push('backup'),
    (r) => checkForbidden(r),
    'DATABASE_URL: shared with the backup service',
  );
  add(
    'age private key variable',
    (r) =>
      void r.keys.push({
        ...clone(find(r, 'BACKUP_AGE_RECIPIENT')),
        name: 'AGE_SECRET_KEY',
      }),
    (r) => checkForbidden(r),
    'AGE_SECRET_KEY: the age private key',
  );
  add(
    'backup forbidden list loses a name',
    (r) => void (r.backupForbidden = r.backupForbidden.filter((n) => n !== 'KEK_V*')),
    (r) => checkForbidden(r),
    'KEK_V*: missing from backupForbidden',
  );
  add(
    'registry entry malformed',
    (r) => void (find(r, 'API_PORT').class = 'private'),
    (r) => checkRegistry(r),
    'API_PORT: class must be',
  );
  add(
    '.env.example misses a variable',
    () => {},
    (r) =>
      checkGenerated(r, {
        envExample: renderEnvExample(r)
          .replace(/^# TRUST_PROXY_HOPS.*\n.*\n/m, '')
          .replace(/^TRUST_PROXY_HOPS=.*\n/m, ''),
        secretsDoc: renderSecretsDoc(r),
      }),
    'TRUST_PROXY_HOPS is not documented',
  );
  add(
    '.env.example carries a secret value',
    () => {},
    (r) =>
      checkGenerated(r, {
        envExample: renderEnvExample(r).replace(/^KEK_PRIVATE_KEYS=$/m, 'KEK_PRIVATE_KEYS=abc'),
        secretsDoc: renderSecretsDoc(r),
      }),
    'KEK_PRIVATE_KEYS has a value without',
  );
  add(
    'local mode default is not local',
    () => {},
    (r) =>
      checkGenerated(r, {
        envExample: renderEnvExample(r).replace(/^IDENTITY_MODE=local$/m, 'IDENTITY_MODE=clerk'),
        secretsDoc: renderSecretsDoc(r),
      }),
    'IDENTITY_MODE must default to local',
  );
  add(
    'secrets doc stale',
    () => {},
    (r) => checkGenerated(r, { envExample: renderEnvExample(r), secretsDoc: 'stale' }),
    'docs/ops/secrets.md: differs',
  );
  add(
    'backup Dockerfile target sets the KEK',
    () => {},
    (r) =>
      checkContainers(r, [
        {
          file: 'docker/Dockerfile',
          text: 'FROM node AS backup\nENV KEK_PRIVATE_KEYS=x\nFROM node AS api\nENV KEK_PRIVATE_KEYS=y\n',
        },
      ]),
    'the backup image or service sets KEK_PRIVATE_KEYS',
  );
  add(
    'api compose service sets the worker secret',
    () => {},
    (r) =>
      checkContainers(r, [
        {
          file: 'docker/compose.x.yml',
          text: 'services:\n  api:\n    environment:\n      R2_LEDGER_SECRET_ACCESS_KEY: x\n',
        },
      ]),
    'the api image or service sets R2_LEDGER_SECRET_ACCESS_KEY',
  );
  add(
    'web image holds the database url',
    () => {},
    (r) =>
      checkContainers(r, [
        { file: 'docker/Dockerfile', text: 'FROM node AS web\nARG DATABASE_URL\n' },
      ]),
    'the web image or service sets DATABASE_URL',
  );
  add(
    'backup holds the age private key',
    () => {},
    (r) =>
      checkContainers(r, [
        {
          file: 'docker/compose.x.yml',
          text: 'services:\n  backup:\n    environment:\n      - AGE_SECRET_KEY=x\n',
        },
      ]),
    'the backup image or service sets AGE_SECRET_KEY',
  );
  const results = cases.map((c) => {
    const mutated = copy();
    c.mutate(mutated);
    const found = c.check(mutated, schema);
    return { name: c.name, caught: found.some((p) => p.includes(c.expect)), found };
  });
  const clean = [...checkRegistry(reg), ...checkSchema(reg, schema), ...checkForbidden(reg)];
  return { results, clean };
}

// ---------------------------------------------------------------------------------------------------------------

function load(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const optional = (p) => (existsSync(join(root, p)) ? read(p) : undefined);
  const reg = JSON.parse(read(PATHS.registry));
  const schema = parseSchema(read(PATHS.schema), read(PATHS.vendors));
  const containers = [
    'docker/Dockerfile',
    'docker/compose.dev.yml',
    'docker/compose.ci.yml',
    'render.yaml',
  ]
    .map((file) => ({ file, text: optional(file) }))
    .filter((f) => f.text !== undefined);
  return {
    reg,
    schema,
    files: { envExample: optional(PATHS.envExample), secretsDoc: optional(PATHS.secretsDoc) },
    containers,
  };
}

async function prettify(text, file) {
  try {
    const prettier = await import('prettier');
    return await prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
  } catch {
    return text;
  }
}

async function main(argv) {
  const arg = (name) => argv.indexOf(name);
  const rootAt = arg('--root');
  const root = rootAt >= 0 ? resolve(argv[rootAt + 1]) : resolve(HERE, '..', '..');
  const { reg, schema, files, containers } = load(root);

  if (arg('--write') >= 0) {
    writeFileSync(join(root, PATHS.envExample), renderEnvExample(reg));
    mkdirSync(join(root, 'docs/ops'), { recursive: true });
    writeFileSync(
      join(root, PATHS.secretsDoc),
      await prettify(renderSecretsDoc(reg), join(root, PATHS.secretsDoc)),
    );
    console.log(
      `wrote ${PATHS.envExample} and ${PATHS.secretsDoc} from ${PATHS.registry} (${reg.keys.length} keys)`,
    );
    return 0;
  }
  if (arg('--local-env') >= 0) {
    const dir = resolve(root, argv[arg('--local-env') + 1] ?? '.env.local.d');
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(localEnvFiles(reg)))
      writeFileSync(join(dir, name), text, { mode: 0o600 });
    console.log(
      `wrote ${SERVICES.length} per-process env files to ${dir} (generated key material, never committed)`,
    );
    return 0;
  }
  if (arg('--probe') >= 0) {
    const { results, clean } = probes(reg, schema);
    for (const r of results) console.log(`${r.caught ? 'caught ' : 'MISSED '} ${r.name}`);
    for (const p of clean) console.log(`unexpected on the merged files: ${p}`);
    const missed = results.filter((r) => !r.caught).length;
    console.log(
      `${results.length - missed}/${results.length} injected mismatches caught; merged files ${clean.length === 0 ? 'pass' : 'FAIL'}`,
    );
    return missed === 0 && clean.length === 0 ? 0 : 1;
  }

  const problems = [
    ...checkRegistry(reg),
    ...checkSchema(reg, schema),
    ...checkForbidden(reg),
    ...checkGenerated(reg, files),
    ...checkContainers(reg, containers),
  ];
  const secrets = reg.keys.filter((k) => k.class === 'secret').length;
  console.log(
    `registry.json: ${reg.keys.length} keys (${secrets} secret); schema.ts: ${schema.size} keys; container files checked: ${containers.map((c) => c.file).join(', ') || 'none present'}`,
  );
  for (const p of problems) console.error(`config-consistency: ${p}`);
  if (problems.length > 0) {
    console.error(`config-consistency: ${problems.length} problem(s)`);
    return 1;
  }
  console.log(
    'config-consistency: registry, schema, .env.example, secrets doc and container definitions agree',
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
