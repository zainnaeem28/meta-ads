/* eslint-disable -- reviewed AIU-13 contract-check (rev 11bcff97), kept as reviewed apart from the samples.json path */
// Contract check for AIU-13 openapi.yaml: SB §5/§6 conformance + response-schema validation with sample bodies.
// Usage: NODE_PATH=<tools>/node_modules node contract-check.cjs openapi.yaml shared-boundaries.md
const fs = require('fs');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const sampler = require('openapi-sampler');

const [oasPath, sbPath] = process.argv.slice(2);
const spec = yaml.load(fs.readFileSync(oasPath, 'utf8'));
const sb = fs.readFileSync(sbPath, 'utf8');
const problems = [];
const P = (m) => problems.push(m);
const norm = (p) => p.replace(/\{[^}]+\}/g, '{}');

// ---- SB §5 operations
const sbOps = {};
for (const line of sb.split('\n')) {
  const m = line.match(
    /^\| (API-\d{3}) \| `(GET|POST|PUT|PATCH|DELETE) ([^`]+)` \| ([^|]+?) \| ([^|]+?) \|/,
  );
  if (m)
    sbOps[m[1]] = {
      method: m[2].toLowerCase(),
      path: norm(m[3]),
      owner: m[4].trim(),
      scope: m[5].trim(),
    };
}
const jobCreating = (sb.match(/job-creating operations are ([^.]+)\./) || [])[1]
  .match(/\d{3}/g)
  .map((n) => 'API-' + n);
const ifMatchOps = ['API-023', 'API-051', 'API-052', 'API-104'];

// ---- SB §6 registry
const registry = {};
for (const line of sb.split('\n')) {
  for (const m of line.matchAll(/\| `([a-z_]+)`(?: \(v3\))? \| (\d{3}) \| [^|]+/g))
    registry[m[1]] = m[2];
}
const enumCodes = spec.components.schemas.ErrorCode.enum;
if (Object.keys(registry).length !== enumCodes.length)
  P(`registry ${Object.keys(registry).length} codes vs enum ${enumCodes.length}`);
for (const c of enumCodes) if (!registry[c]) P(`enum code ${c} not in SB registry`);
for (const c of Object.keys(registry))
  if (!enumCodes.includes(c)) P(`registry code ${c} not in enum`);

// ---- operations
const resolve = (o) =>
  o && o.$ref
    ? o.$ref
        .split('/')
        .slice(1)
        .reduce((a, k) => a[k], spec)
    : o;
const seen = {};
const tokenOps = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ['get', 'put', 'post', 'patch', 'delete']) {
    const op = item[method];
    if (!op) continue;
    const id = op['x-api-id'];
    seen[id] = true;
    const s = sbOps[id];
    if (!s) {
      P(`${id} not in SB §5`);
      continue;
    }
    if (s.method !== method || s.path !== norm(path))
      P(`${id} method/path ${method} ${path} vs SB ${s.method} ${s.path}`);
    if (!s.owner.includes(op['x-owner'])) P(`${id} owner ${op['x-owner']} vs SB ${s.owner}`);
    const isPublic = Array.isArray(op.security) && op.security.length === 0;
    if (isPublic !== s.scope.startsWith('Pub'))
      P(`${id} security public=${isPublic} vs SB scope ${s.scope}`);
    // Scope M (TD-D41): metrics token only, refusal is 404 not_found, never 401/403; no other operation uses the scheme.
    const schemes = (op.security || spec.security || []).flatMap((r) => Object.keys(r));
    const isMetrics = schemes.includes('metricsToken');
    if (isMetrics !== (s.scope === 'M'))
      P(`${id} metricsToken=${isMetrics} vs SB scope ${s.scope}`);
    if (isMetrics) {
      tokenOps.push(id);
      if (schemes.length !== 1) P(`${id} scope M must use metricsToken alone`);
      if (!op.responses['404'] || !(op['x-error-codes'] || []).includes('not_found'))
        P(`${id} scope M without 404 not_found`);
      for (const st of ['401', '403']) if (op.responses[st]) P(`${id} scope M declares ${st}`);
    }
    const usesSession = schemes.includes('sessionBearer');
    const params = [...(item.parameters || []), ...(op.parameters || [])].map(resolve);
    const hasIdem = params.some(
      (p) => p.in === 'header' && p.name === 'Idempotency-Key' && p.required,
    );
    if (hasIdem !== jobCreating.includes(id)) P(`${id} Idempotency-Key required=${hasIdem}`);
    const hasIfMatch = params.some((p) => p.in === 'header' && p.name === 'If-Match' && p.required);
    if (hasIfMatch !== ifMatchOps.includes(id)) P(`${id} If-Match required=${hasIfMatch}`);
    const statuses = Object.keys(op.responses);
    for (const c of op['x-error-codes'] || []) {
      if (!registry[c]) P(`${id} x-error-code ${c} not in registry`);
      else if (!statuses.includes(registry[c]))
        P(`${id} x-error-code ${c} lacks ${registry[c]} response`);
    }
    if (usesSession)
      for (const st of ['400', '401', '403', '429', '500', '503'])
        if (!statuses.includes(st)) P(`${id} missing common ${st}`);
    if (statuses.includes('429')) {
      const r = resolve(op.responses['429']);
      if (!r.headers || !r.headers['Retry-After']) P(`${id} 429 without Retry-After`);
    }
  }
}
for (const id of Object.keys(sbOps)) if (!seen[id]) P(`${id} in SB but not in openapi`);

// ---- 405 shape (TD-D34, TD-D37): one shared response, error envelope, required Allow header
const mna = (spec.components.responses || {}).MethodNotAllowed;
if (!mna) P('components.responses.MethodNotAllowed missing');
else {
  if (!mna.headers || !mna.headers.Allow || mna.headers.Allow.required !== true)
    P('MethodNotAllowed without required Allow header');
  const sch =
    mna.content && mna.content['application/json'] && mna.content['application/json'].schema;
  if (!sch || sch.$ref !== '#/components/schemas/ErrorResponse')
    P('MethodNotAllowed body is not ErrorResponse');
}
if (!enumCodes.includes('method_not_allowed')) P('method_not_allowed not in enum');

// ---- response-schema validation with sample bodies
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, 'oas');
const validatorFor = (ref) => ajv.compile({ $ref: 'oas' + ref.slice(ref.indexOf('#')) });
const hasSchema = (ref) => Boolean((spec.components.schemas || {})[ref.split('/').pop()]);
const now = '2026-11-14T23:30:00.000Z';
const uuid = '01936a3e-7c1a-7b2c-8d3e-4f5a6b7c8d9e';
// Fix up sampler output where the sampler cannot meet patterns or formats.
function fix(v, key) {
  if (Array.isArray(v)) return v.map((x) => fix(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = fix(x, k);
    return o;
  }
  if (typeof v === 'string' && key === 'last4') return 'ab12';
  if (typeof v === 'string' && key === 'fingerprint') return '0a1b2c3d4e5f';
  if (typeof v === 'string' && /Usd$/.test(key || '')) return '12.3456';
  return v;
}
let validated = 0;
const responseRefs = new Set();
for (const [path, item] of Object.entries(spec.paths))
  for (const m of ['get', 'put', 'post', 'patch', 'delete']) {
    const op = item[m];
    if (!op) continue;
    for (const [st, r0] of Object.entries(op.responses)) {
      const r = resolve(r0);
      const sch =
        r.content && r.content['application/json'] && r.content['application/json'].schema;
      if (sch && sch.$ref) responseRefs.add(sch.$ref);
      else if (sch) P(`${op['x-api-id']} ${st} inline response schema`);
    }
  }
const overrides = JSON.parse(
  fs.readFileSync(
    require('path').join(__dirname, '..', '..', 'packages', 'contracts', 'samples.json'),
    'utf8',
  ),
);
for (const ref of [...responseRefs].sort()) {
  const name = ref.split('/').pop();
  const v = validatorFor(ref);
  let body =
    overrides[name] ||
    fix(
      sampler.sample(resolve({ $ref: ref }), { skipReadOnly: false, skipNonRequired: false }, spec),
    );
  if (!v(body)) P(`sample ${name} invalid: ${ajv.errorsText(v.errors, { separator: '; ' })}`);
  else validated++;
}
// Negative checks: closed envelopes must stay closed.
const mw = (minutes) => ({ minutes, from: now, to: now, requests: 0, errors5xx: 0, p95Ms: null });
const pw = { minutes: 10, acquisitions: 0, waited: 0, p95WaitMs: null };
const neg = [
  [
    '#/components/schemas/PageMetaData',
    {
      requestId: 'r1',
      timestamp: now,
      pagination: {
        type: 'cursor',
        limit: 20,
        returnedCount: 0,
        hasNextPage: false,
        nextCursor: null,
      },
      extra: 1,
    },
  ],
  ['#/components/schemas/MetaData', { requestId: 'r1', timestamp: now, pagination: {} }],
  [
    '#/components/schemas/CursorPagination',
    { type: 'cursor', limit: 20, returnedCount: 1, hasNextPage: true, nextCursor: null },
  ],
  [
    '#/components/schemas/ErrorResponse',
    {
      success: false,
      error: { code: 'not_a_code', message: 'x' },
      metaData: { requestId: 'r1', timestamp: now },
    },
  ],
  // design.4: the window summary has exactly the 10- and 15-minute entries (one entry only)
  [
    '#/components/schemas/MetricsWindow',
    {
      processStartedAt: now,
      windows: [mw(10)],
      poolWait: pw,
      telemetryDropped10m: 0,
      telemetryDroppedTotal: 0,
    },
  ],
  // design.5 (SAR-AIU200-L3): entries out of order, or the same window twice
  [
    '#/components/schemas/MetricsWindow',
    {
      processStartedAt: now,
      windows: [mw(15), mw(10)],
      poolWait: pw,
      telemetryDropped10m: 0,
      telemetryDroppedTotal: 0,
    },
  ],
  [
    '#/components/schemas/MetricsWindow',
    {
      processStartedAt: now,
      windows: [mw(10), mw(10)],
      poolWait: pw,
      telemetryDropped10m: 0,
      telemetryDroppedTotal: 0,
    },
  ],
  [
    '#/components/schemas/MetricsWindow',
    {
      processStartedAt: now,
      windows: [mw(10), mw(15), mw(15)],
      poolWait: pw,
      telemetryDropped10m: 0,
      telemetryDroppedTotal: 0,
    },
  ],
  // design.5 (SAR-AIU200-M1, TD-D42): the windowed ALR-9 input is required
  [
    '#/components/schemas/MetricsWindow',
    { processStartedAt: now, windows: [mw(10), mw(15)], poolWait: pw, telemetryDroppedTotal: 0 },
  ],
];
// A spec without a negative sample's schema is a problem, not a crash (SAR-AIU200-L1).
const missingNeg = new Set();
for (const [ref, body] of neg) {
  if (!hasSchema(ref)) missingNeg.add(ref);
  else if (validatorFor(ref)(body)) P(`negative sample accepted by ${ref}`);
}
for (const ref of missingNeg) P(`negative samples not run: ${ref} missing`);

console.log(
  `SB operations: ${Object.keys(sbOps).length}; openapi operations: ${Object.keys(seen).length}; job-creating: ${jobCreating.join(',')}`,
);
console.log(
  `registry codes: ${Object.keys(registry).length}; enum: ${enumCodes.length}; 405 shape: ${mna ? 'MethodNotAllowed' : 'missing'}; metrics-token (M) operations: ${tokenOps.join(',') || 'none'}`,
);
console.log(
  `response schemas validated with samples: ${validated}/${responseRefs.size}; negative checks: ${neg.length}`,
);
console.log(
  problems.length ? problems.join('\n') + `\n${problems.length} problem(s)` : '0 problems',
);
process.exit(problems.length ? 1 : 0);
