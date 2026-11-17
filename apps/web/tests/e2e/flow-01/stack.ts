import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The FLOW-01 stack: the built api and worker (`apps/api/dist`, the composition roots `main.*` run) in this process,
 * on a throwaway database of the shared test PostgreSQL, a real MinIO server, and a local TLS server standing in for
 * api.openai.com (the provider stub: the real one is never called). The built web app is started by the Playwright
 * config. Nothing here is a mock of the product: the api, the worker and the database are the real code.
 */
const ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const API = join(ROOT, 'apps', 'api');
// Native dynamic import: the tests are compiled to CommonJS, the built api and the media tools are ES modules.
const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const dist = (file: string) => pathToFileURL(join(API, 'dist', file)).href;
const requireApi = createRequire(pathToFileURL(join(API, 'package.json')));

const OPENAI_KEY = 'sk-flow01-integration-openai-key-0123456789abcdef';

/** What the provider stub answers; tests change `mode` to drive the failure paths. */
export interface StubState {
  mode: 'ok' | 'fail';
  seen: { model: string; kind: 'vision' | 'brief' }[];
}

interface Pool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface Stack {
  readonly apiUrl: string;
  readonly webOrigin: string;
  readonly controlUrl: string;
  readonly stub: StubState;
  stop(): Promise<void>;
}

const calm = (n: number): string =>
  Array.from({ length: n }, (_, i) =>
    i % 5 === 4 || i === n - 1 ? `calm${String(i)}.` : `calm${String(i)}`,
  ).join(' ');

const chat = (content: unknown) => ({
  choices: [{ message: { role: 'assistant', content: JSON.stringify(content), refusal: null } }],
});

function statementsOf(dir: string, file: string): string[] {
  const [tables = ''] = readFileSync(join(dir, file), 'utf8').split('-- Grants');
  return tables
    .split('--> statement-breakpoint')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s !== '');
}

export async function startStack(ports: {
  api: number;
  web: number;
  control: number;
}): Promise<Stack> {
  const pg = requireApi('pg') as {
    Pool: new (options: { connectionString: string; max: number }) => Pool;
  };
  const { createTestDatabase } = await load(dist('platform/db/test-database.js'));
  const { installJobs } = await load(dist('platform/jobs/test-support.js'));
  const { startServer } = await load(dist('platform/egress/test-support.js'));
  const { Egress, EGRESS } = await load(dist('platform/egress/index.js'));
  const { createApiApp } = await load(dist('bootstrap/api.module.js'));
  const { createWorkerApp } = await load(dist('bootstrap/worker.module.js'));
  const { createHttpLogging, buildLogger } = await load(dist('platform/logging/index.js'));
  const { runSeed } = await load(dist('database/seed.js'));
  const { priceTableSeedStep } = await load(dist('modules/usage/index.js'));
  const { brandRulesSeedStep } = await load(
    dist('modules/brief/infrastructure/repositories/brand-rules-file.js'),
  );
  const { IDENTITY_PORT } = await load(dist('modules/identity/index.js'));
  const { KEY_WRAP_PORT } = await load(dist('modules/provider-keys/index.js'));
  const { Module } = requireApi('@nestjs/common') as {
    Module(metadata: object): (target: object) => void;
  };
  const { S3Client, CreateBucketCommand } = requireApi('@aws-sdk/client-s3') as {
    S3Client: new (options: object) => { send(command: object): Promise<unknown>; destroy(): void };
    CreateBucketCommand: new (options: object) => object;
  };
  const minioUrl = pathToFileURL(join(ROOT, 'tools', 'foundation-tests', 'media', 'minio.ts')).href;
  const { startMinio } = (await load(minioUrl)) as {
    startMinio(): Promise<{
      endpoint: string;
      accessKey: string;
      secretKey: string;
      stop(): Promise<void>;
    }>;
  };

  const webOrigin = `http://127.0.0.1:${String(ports.web)}`;
  const stub: StubState = { mode: 'ok', seen: [] };
  const provider = await startServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}') as {
        model?: string;
        messages?: { content: unknown }[];
      };
      const vision = JSON.stringify(body.messages ?? []).includes('image_url');
      stub.seen.push({ model: body.model ?? '', kind: vision ? 'vision' : 'brief' });
      res.setHeader('content-type', 'application/json');
      if (stub.mode === 'fail') {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: 'stub failure' } }));
        return;
      }
      res.statusCode = 200;
      res.end(
        JSON.stringify(
          vision
            ? chat({
                productDescription:
                  'A glass bottle of 60 capsules with a green mushroom label and a silver cap.',
              })
            : chat({
                segments: [
                  {
                    position: 1,
                    dialogue: `I tried a slow morning ${calm(28)} and it fit`,
                    prompt: 'A calm kitchen at sunrise',
                  },
                  {
                    position: 2,
                    dialogue: `${calm(27)} Adults 21 and over only`,
                    prompt: 'A morning window with the bottle',
                  },
                ],
              }),
        ),
      );
    });
  });

  const minio = await startMinio();
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: minio.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  await s3.send(new CreateBucketCommand({ Bucket: 'app' }));
  s3.destroy();

  const database = await createTestDatabase({ label: 'flow01', migrations: false });
  const pool = new pg.Pool({ connectionString: database.url, max: 4 });
  // The roles of M0001 do not exist on the shared test server: each migration's tables are applied as written (the
  // grants are proven by the migration suites) and the processes connect as the database owner.
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const file of [
    '0001_task-025-platform.sql',
    '0010_task-032-audit.sql',
    '0020_task-033-identity.sql',
    '0030_task-039-provider-keys.sql',
    '0040_task-041-media.sql',
    '0050_task-044-usage.sql',
    '0060_task-058-lifecycle.sql',
    '0070_task-046-campaigns.sql',
    '0080_task-048-brief.sql',
    '0090_task-052-production-video.sql',
    '0100_task-055-production-assembly.sql',
    '0110_task-057-production-thumbstopper.sql',
  ]) {
    for (const statement of statementsOf(join(API, 'src', 'database', 'migrations'), file)) {
      if (
        /^\s*(DO\b|CREATE ROLE|ALTER ROLE)/i.test(statement) &&
        /app_(api|worker|migrator|backup)/.test(statement)
      )
        continue;
      await pool.query(statement);
    }
  }
  await installJobs(database.url);
  await runSeed({
    dataset: 'reference',
    appEnv: 'development',
    databaseUrl: database.url,
    steps: [priceTableSeedStep(), brandRulesSeedStep()],
  });

  const kek = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
  const pepper = Buffer.alloc(32, 'p').toString('base64');
  const env: Record<string, string> = {
    KEK_PUBLIC_KEYS: JSON.stringify({
      1: kek.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }),
    KEK_PRIVATE_KEYS: JSON.stringify({
      1: kek.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
    KEK_ACTIVE_VERSION: '1',
    KEY_FINGERPRINT_PEPPERS: JSON.stringify({ 1: pepper }),
    KEY_FINGERPRINT_PEPPER_ACTIVE: '1',
    R2_ENDPOINT: minio.endpoint,
    R2_BUCKET: 'app',
    R2_ACCESS_KEY_ID: minio.accessKey,
    R2_SECRET_ACCESS_KEY: minio.secretKey,
    STORAGE_PUBLIC_ORIGIN: minio.endpoint,
    OWNER_EMAIL: 'owner-flow01@example.test',
    INVITE_EMAIL_DOMAINS: 'example.test',
    CURSOR_SIGNING_KEY: 'k'.repeat(40),
    MEDIA_UNATTACHED_TTL_HOURS: '24',
    OPENAI_TEXT_MODEL: 'local-stub-text',
    OPENAI_VISION_MODEL: 'local-stub-vision',
    IDENTITY_MODE: 'local',
  };
  // The api never holds the private key (it refuses to start with it); the worker is handed it through its own `env`.
  const { KEK_PRIVATE_KEYS, ...shared } = env;
  Object.assign(process.env, shared);

  class StubEgress {}
  Module({})(StubEgress);
  const egress = new Egress({
    allowedHosts: { openai: ['api.openai.com'] },
    timeoutMs: 3000,
    maxBytes: 5_000_000,
    resolver: async () => ['127.0.0.1'],
    testing: { isBlockedAddress: () => false, tls: { ca: provider.ca }, port: provider.port },
  });
  const egressModule = {
    module: StubEgress,
    providers: [{ provide: EGRESS, useValue: egress }],
    exports: [EGRESS],
  };
  const quiet = buildLogger({ level: 'silent' });
  const worker = await createWorkerApp(
    {
      DATABASE_URL: database.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      WORKER_WATCHDOG_SECONDS: 180,
      WORKER_DRAIN_SECONDS: 5,
      WORKER_CONCURRENCY_PROVIDER: 2,
      WORKER_CONCURRENCY_SANITIZE: 1,
      WORKER_CONCURRENCY_DELETION: 1,
    },
    {
      logger: quiet.logger,
      egress: egressModule,
      openAiChatUrl: `https://api.openai.com:${String(provider.port)}/v1/chat/completions`,
      env: { ...process.env, KEK_PRIVATE_KEYS },
      exit: () => undefined,
    },
  );
  const wrap = worker.context.get(KEY_WRAP_PORT, { strict: false }) as {
    seal(
      key: Buffer,
      ctx: object,
    ): { ciphertext: Buffer; nonce: Buffer; wrappedDek: Buffer; kekVersion: number };
  };

  const { app } = await createApiApp(
    {
      WEB_ORIGIN: webOrigin,
      APP_ENV: 'development',
      DATABASE_URL: database.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: process.env.FLOW01_LOG ?? 'silent' }),
  );
  await app.listen(ports.api, '127.0.0.1');
  const local = app.get(IDENTITY_PORT, { strict: false }) as {
    addUser(sub: string, email: string, verified: boolean): void;
    issueToken(spec: {
      sub: string;
      azp: string;
      fva: [number, number];
      ttlSeconds?: number;
    }): string;
  };

  // A linked operator on demand, with an OpenAI key or without one (the key-missing path).
  const accounts = new Map<string, string>();
  const account = async (sub: string, withKey: boolean): Promise<string> => {
    const known = accounts.get(sub);
    if (known !== undefined) return known;
    const id = randomUUID();
    const email = `${sub}@example.test`;
    local.addUser(sub, email, true);
    await pool.query(
      `insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`,
      [id, sub, email],
    );
    accounts.set(sub, id);
    if (withKey) {
      const keyId = randomUUID();
      const sealed = wrap.seal(Buffer.from(OPENAI_KEY), {
        userId: id,
        provider: 'openai',
        keyId,
        version: 1,
      });
      await pool.query(
        `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
         values ($1, $2, 'openai', 'active', 1, $3, $4, $5, $6, 'cdef', $7, 1)`,
        [
          keyId,
          id,
          sealed.ciphertext,
          sealed.nonce,
          sealed.wrappedDek,
          sealed.kekVersion,
          'a'.repeat(64),
        ],
      );
    }
    return id;
  };

  // The test-side control: mints session tokens for the local identity provider (the web app in local mode sends no
  // bearer, so the tests add one at the network layer) and answers read-only queries for the persisted state.
  const control: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    void (async () => {
      if (url.pathname === '/token') {
        const sub = url.searchParams.get('sub') ?? `flow01_${randomUUID().slice(0, 12)}`;
        const userId = await account(sub, url.searchParams.get('key') !== '0');
        res.end(
          JSON.stringify({
            sub,
            userId,
            token: local.issueToken({ sub, azp: webOrigin, fva: [1, 1], ttlSeconds: 3600 }),
          }),
        );
      } else if (url.pathname === '/sql') {
        const text = url.searchParams.get('q') ?? '';
        if (!/^\s*select\b/i.test(text)) {
          res.statusCode = 400;
          res.end('{"error":"select only"}');
          return;
        }
        res.end(JSON.stringify((await pool.query(text)).rows));
      } else if (url.pathname === '/stub') {
        stub.mode = url.searchParams.get('mode') === 'fail' ? 'fail' : 'ok';
        res.end(JSON.stringify({ mode: stub.mode, seen: stub.seen }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((done) => control.listen(ports.control, '127.0.0.1', done));

  return {
    apiUrl: `http://127.0.0.1:${String(ports.api)}`,
    webOrigin,
    controlUrl: `http://127.0.0.1:${String(ports.control)}`,
    stub,
    async stop() {
      control.closeAllConnections();
      await new Promise((done) => control.close(done));
      await app.close().catch(() => undefined);
      await worker.runtime.drain().catch(() => undefined);
      await worker.context.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await database.drop().catch(() => undefined);
      await minio.stop().catch(() => undefined);
      await provider.close().catch(() => undefined);
    },
  };
}
