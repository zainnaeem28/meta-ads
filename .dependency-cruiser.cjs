/* global module */
// Layer boundary rules (ARCHITECTURE section 1.4; layer table from shared-boundaries section 4.1).
// A module may import another module's index.ts only when the other module sits on a lower layer.
// scripts/ci/layers.sh runs this file; scripts/ci/probes/layers/ holds one negative fixture per rule.

const LAYERS = {
  audit: 1,
  identity: 2,
  'provider-keys': 3,
  media: 3,
  usage: 3,
  campaigns: 4,
  brief: 5,
  production: 6,
  lifecycle: 7,
  reporting: 7,
};

const MODULES = 'apps/api/src/modules';
const FRAMEWORKS =
  '(@nestjs|drizzle-orm|openai|@aws-sdk|@clerk|pg|pg-boss|fastify|@fastify|sharp|undici)';

const upward = Object.entries(LAYERS).map(([name, layer]) => {
  const sameOrHigher = Object.entries(LAYERS)
    .filter(([other, otherLayer]) => other !== name && otherLayer >= layer)
    .map(([other]) => other);
  return {
    name: 'no-upward-module-import',
    comment: `${name} (layer ${layer}) may only import lower-layer modules`,
    severity: 'error',
    from: { path: `^${MODULES}/${name}/` },
    to: { path: `^${MODULES}/(${sameOrHigher.join('|')})/` },
  };
});

module.exports = {
  forbidden: [
    ...upward,
    {
      name: 'no-deep-import',
      comment: "only another module's index.ts is importable from outside it",
      severity: 'error',
      from: {
        pathNot: [`^${MODULES}/([^/]+)/`, '^apps/api/src/bootstrap/', '^apps/api/src/main\\.'],
      },
      to: { path: `^${MODULES}/([^/]+)/(application|domain|infrastructure|transport)/` },
    },
    {
      name: 'no-deep-import',
      comment: "only another module's index.ts is importable from outside it",
      severity: 'error',
      from: { path: `^${MODULES}/([^/]+)/` },
      to: {
        path: `^${MODULES}/([^/]+)/(application|domain|infrastructure|transport)/`,
        pathNot: `^${MODULES}/$1/`,
      },
    },
    {
      name: 'no-platform-to-modules',
      comment: 'platform (L0) never imports a feature module',
      severity: 'error',
      from: { path: '^apps/api/src/platform/', pathNot: '^apps/api/src/platform/ops-cli/' },
      to: { path: `^${MODULES}/` },
    },
    {
      name: 'no-domain-to-frameworks',
      comment: 'domain code imports no framework, ORM or SDK',
      severity: 'error',
      from: { path: `^${MODULES}/[^/]+/domain/` },
      to: { path: `(^|node_modules/)${FRAMEWORKS}(/|$)` },
    },
    {
      name: 'no-application-to-infrastructure',
      comment: 'application code reaches adapters only through interfaces',
      severity: 'error',
      from: { path: `^${MODULES}/([^/]+)/application/` },
      to: { path: `^${MODULES}/[^/]+/infrastructure/` },
    },
    {
      name: 'no-cycles',
      comment: 'no circular dependency anywhere',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'unsealer-worker-only',
      comment: 'only the worker composition root may import the key unsealer',
      severity: 'error',
      from: {
        pathNot: [
          '^apps/api/src/bootstrap/worker\\.module\\.ts$',
          `^${MODULES}/provider-keys/infrastructure/`,
          '\\.(test|spec)\\.ts$',
        ],
      },
      to: { path: `^${MODULES}/provider-keys/infrastructure/key-unsealer\\.ts$` },
    },
    {
      name: 'web-no-api',
      comment: 'the web app never imports the api app',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/api/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    exclude: { path: ['/node_modules/', '/dist/', '/\\.next/'] },
  },
};
