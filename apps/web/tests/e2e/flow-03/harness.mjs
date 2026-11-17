// FLOW-03 harness: the parts of the running product that are not the built web app or the built api, in one plain node
// process (started by the Playwright config next to them). It stands in for what the journey needs behind the api:
//  - the worker, run in-process through `createWorkerApp` from the built api (apps/api/dist), configured through the real
//    worker validator, with a programmatic Egress that admits only the stub host (AIU-259 decision D-1). The production
//    entry `main.worker.js` and the production egress wiring are NOT exercised here (see docs/evidence/TASK-106/README.md);
//  - a local TLS server standing in for api.wavespeed.ai, its output host and api.openai.com (the real ones are never called);
//  - an in-process S3 stand-in the worker writes clips to and the api presigns links for;
//  - real FFmpeg and ffprobe (quality check audio extraction), real clip files made once by FFmpeg;
//  - a small control server the spec uses to seed accounts and to steer the stub (it never touches the product's code).
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const api = resolve(import.meta.dirname, '../../../../api');
const dist = join(api, 'dist');
const load = (file) => import(pathToFileURL(`${dist}/${file}`).href);
const requireApi = createRequire(join(api, 'package.json'));
requireApi('reflect-metadata');
const pg = requireApi('pg');
const { Module } = requireApi('@nestjs/common');

const DATABASE_URL = process.env.FLOW03_DATABASE_URL;
const CONTROL_PORT = Number(process.env.FLOW03_CONTROL_PORT);
const BUCKET_PORT = Number(process.env.FLOW03_BUCKET_PORT);
const FFMPEG = process.env.FFMPEG_PATH;
const FFPROBE = process.env.FFPROBE_PATH;
if (!DATABASE_URL || !CONTROL_PORT || !BUCKET_PORT || !FFMPEG || !FFPROBE)
  throw new Error('FLOW03_DATABASE_URL, FLOW03_CONTROL_PORT, FLOW03_BUCKET_PORT, FFMPEG_PATH and FFPROBE_PATH are required');

const WAVESPEED_KEY = 'flow03-wavespeed-secret-0123456789abcdef';
const OPENAI_KEY = 'flow03-openai-secret-0123456789abcdef';
const API_HOST = 'api.openai.com';
const CDN_HOST = 'cdn.example.net';
/** What each segment says; the stub "hears" this when its quality check passes. */
const DIALOGUE = [
  '',
  'I used to rush through every morning until a friend told me about this calm drink. I tried it last week, and honestly the first sip made my whole kitchen feel quieter and slower.',
  'You just stir one scoop into cold water, wait a few seconds, and take a slow breath. It tastes light and a little sweet, and it never feels heavy or fussy at all.',
  'By the third day I noticed I was less hurried getting out the door. Nothing dramatic, just a steadier start, and a small ritual that I actually look forward to now.',
  'If your mornings feel like a sprint, give it a try tomorrow and see how it feels. Tap the link below to grab yours and start your own calm morning ritual.',
];
const MISMATCH = 'Completely different words nobody wrote in the script.';

// ---- real clips: one second of video with a tone per segment (400 Hz x position), made by the real FFmpeg once ------------
const clipDir = mkdtempSync(join(tmpdir(), 'flow03-clips-'));
const clips = new Map();
for (const position of [1, 2, 3, 4]) {
  const file = join(clipDir, `clip-${position}.mp4`);
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x284:rate=10',
    '-f', 'lavfi', '-i', `sine=frequency=${400 * position}:sample_rate=16000:duration=1`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', file,
  ]);
  clips.set(position, readFileSync(file));
}
// The worker finds `ffmpeg` and `ffprobe` on the PATH.
const dirs = [FFMPEG, FFPROBE].filter((f) => f.includes('/')).map((f) => join(f, '..'));
process.env.PATH = [...dirs, process.env.PATH ?? ''].join(delimiter);

// ---- the S3 stand-in (path-style, plain http): the calls the storage adapter makes -----------------------------------------
const objects = new Map();
const xml = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/xml');
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
};
const s3error = (res, status, code) => xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
const bucketServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const body = Buffer.concat(parts);
    res.setHeader('access-control-allow-origin', '*');
    if (key === '' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const listed = [...objects.entries()].filter(([n]) => n.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const contents = listed
        .map(([n, o]) => `<Contents><Key>${n}</Key><Size>${o.body.length}</Size><LastModified>${o.at.toISOString()}</LastModified></Contents>`)
        .join('');
      return xml(res, 200, `<ListBucketResult><Name>app</Name><Prefix>${prefix}</Prefix><KeyCount>${listed.length}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    }
    if (key === '' && req.method === 'POST' && url.searchParams.has('delete')) {
      for (const m of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) objects.delete(m[1]);
      return xml(res, 200, '<DeleteResult></DeleteResult>');
    }
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && objects.has(key)) return s3error(res, 412, 'PreconditionFailed');
      objects.set(key, { body, type: String(req.headers['content-type'] ?? ''), at: new Date() });
      res.setHeader('etag', '"stub"');
      res.statusCode = 200;
      return res.end();
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const found = objects.get(key);
      if (found === undefined) return s3error(res, 404, 'NoSuchKey');
      res.setHeader('content-type', found.type);
      res.setHeader('content-length', String(found.body.length));
      res.statusCode = 200;
      return res.end(req.method === 'HEAD' ? undefined : found.body);
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.statusCode = 204;
      return res.end();
    }
    return s3error(res, 400, 'BadRequest');
  });
});
await new Promise((r) => bucketServer.listen(BUCKET_PORT, '127.0.0.1', r));

// ---- the provider stub -------------------------------------------------------------------------------------------------------
const behaviour = { failOnce: new Set(), submit: 'ok', qcMismatch: new Set() };
const tasks = new Map(); // task id -> { position, fail }
const calls = [];
let taskCounter = 0;
const { startServer } = await load('platform/egress/test-support.js');

/** The tone of the extracted audio says which clip it is: count the zero crossings of the 16 kHz mono PCM. */
function positionOfAudio(multipart) {
  const at = multipart.indexOf('RIFF');
  if (at < 0) return 0;
  const data = multipart.indexOf('data', at);
  const pcm = multipart.subarray(data + 8, Math.max(data + 8, multipart.lastIndexOf('\r\n--')));
  let crossings = 0;
  let last = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i);
    if (v !== 0 && last !== 0 && Math.sign(v) !== Math.sign(last)) crossings += 1;
    if (v !== 0) last = v;
  }
  const hz = crossings / 2 / (pcm.length / 2 / 16000);
  return Math.min(4, Math.max(1, Math.round(hz / 400)));
}

const stub = await startServer((req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const body = Buffer.concat(parts);
    const url = req.url ?? '';
    calls.push({ method: req.method, url: url.split('?')[0] });
    const json = (status, value) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (req.method === 'POST' && url === '/v1/audio/transcriptions') {
      const position = positionOfAudio(body);
      return json(200, { text: behaviour.qcMismatch.has(position) ? MISMATCH : DIALOGUE[position] });
    }
    if (req.method === 'POST' && url.startsWith('/api/v3/predictions/delete')) return json(200, { code: 200, message: 'success' });
    if (req.method === 'POST' && url.startsWith('/api/v3/')) {
      if (behaviour.submit === 'hang') return; // the answer never comes: the client gives up, the outcome is unknown
      if (behaviour.submit === 'credit') return json(402, { code: 402, message: 'insufficient credit' });
      const position = Number(/Segment (\d)/.exec(JSON.parse(body.toString()).prompt ?? '')?.[1] ?? 1);
      const fail = behaviour.failOnce.delete(position);
      taskCounter += 1;
      const id = `task-${taskCounter}-seg${position}`;
      tasks.set(id, { position, fail });
      return json(200, { code: 200, message: 'success', data: { id, status: 'created' } });
    }
    const read = /^\/api\/v3\/predictions\/([^/]+)\/result$/.exec(url);
    if (req.method === 'GET' && read !== null) {
      const task = tasks.get(read[1]);
      if (task === undefined) return json(404, { code: 404, message: 'no such task' });
      if (task.fail) return json(200, { code: 200, data: { id: read[1], status: 'failed', outputs: [], error: 'The provider could not render this clip.' } });
      return json(200, {
        code: 200,
        data: { id: read[1], status: 'completed', outputs: [`https://${CDN_HOST}:${stub.port}/files/clip-${task.position}.mp4`], error: '' },
      });
    }
    const file = /^\/files\/clip-(\d)\.mp4$/.exec(url);
    if (file !== null) {
      res.setHeader('content-type', 'video/mp4');
      return res.end(clips.get(Number(file[1])));
    }
    res.statusCode = 404;
    res.end();
  });
});

// ---- the worker, in-process, through the real worker validator -------------------------------------------------------------
const { validateConfig } = await load('platform/config/schema.js');
const { createWorkerApp } = await load('bootstrap/worker.module.js');
const { EGRESS, Egress } = await load('platform/egress/index.js');
const { createRuntimeBoss, startRuntimeBoss } = await load('platform/jobs/boss.js');
const { buildLogger } = await load('platform/logging/index.js');
const { STORAGE_PORT } = await load('modules/media/index.js');
const { KEY_WRAP_PORT } = await load('modules/provider-keys/index.js');

const kek = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
const workerEnv = {
  APP_ENV: 'test',
  DATABASE_URL,
  KEK_PUBLIC_KEYS: JSON.stringify({ 1: kek.publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
  KEK_PRIVATE_KEYS: JSON.stringify({ 1: kek.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
  KEK_ACTIVE_VERSION: '1',
  R2_ENDPOINT: `http://127.0.0.1:${BUCKET_PORT}`,
  R2_BUCKET: 'app',
  R2_ACCESS_KEY_ID: 'stub-access',
  R2_SECRET_ACCESS_KEY: 'stub-secret',
  R2_LEDGER_BUCKET: 'ledger',
  R2_LEDGER_ACCESS_KEY_ID: 'stub-ledger-access',
  R2_LEDGER_SECRET_ACCESS_KEY: 'stub-ledger-secret',
  CLERK_SECRET_KEY: 'sk_test_fixture',
  POLL_INTERVAL_SEC: '2',
  PROVIDER_OUTPUT_COPY_WINDOW_HOURS: '1',
  PROVIDER_OUTPUT_MAX_BYTES: '5000000',
  KEY_AUTO_DISABLE_THRESHOLD: '5',
};
const validated = validateConfig('worker', workerEnv);
if (!validated.ok) throw new Error(`worker config refused: ${validated.issues.map((i) => `${i.key} ${i.fault}`).join(', ')}`);

class StubEgress {}
Module({})(StubEgress);
const egressModule = () => ({
  module: StubEgress,
  providers: [
    {
      provide: EGRESS,
      useValue: new Egress({
        allowedHosts: { wavespeed: [API_HOST, CDN_HOST], openai: [API_HOST] },
        timeoutMs: 2500,
        maxBytes: 20_000_000,
        resolver: async () => ['127.0.0.1'],
        testing: { isBlockedAddress: (address) => address !== '127.0.0.1', tls: { ca: stub.ca }, port: stub.port },
      }),
    },
  ],
  exports: [EGRESS],
});

const lines = [];
const sink = new Writable({
  write(chunk, _e, done) {
    lines.push(chunk.toString());
    if (lines.length > 2000) lines.shift();
    done();
  },
});
const { logger } = buildLogger({ level: 'info', destination: sink });
const worker = await createWorkerApp(validated.config, {
  logger,
  egress: egressModule(),
  wavespeedBaseUrl: `https://${API_HOST}:${stub.port}`,
  env: workerEnv,
  exit: () => undefined,
});
const wrap = worker.context.get(KEY_WRAP_PORT, { strict: false });
void STORAGE_PORT;
// The api is a separate process; this boss only lets the harness send nothing and keeps the schema honest.
const apiBoss = createRuntimeBoss({ DATABASE_URL, role: 'api' });
apiBoss.on('error', () => undefined);
await startRuntimeBoss(apiBoss);

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

// ---- seeding: an account (as the api's local identity names it), its keys, and a campaign with an accepted brief -------------
const subjectOf = (email) => `user_local_${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)}`;

async function seed({ email, keys = {}, reservedUsd, segments = 4 }) {
  const owner = randomUUID();
  await pool.query(`insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`, [
    owner,
    subjectOf(email),
    email.toLowerCase(),
  ]);
  for (const [provider, secret] of [['wavespeed', WAVESPEED_KEY], ['openai', OPENAI_KEY]]) {
    const status = keys[provider] ?? 'active';
    if (status === 'none') continue;
    const keyId = randomUUID();
    const sealed = wrap.seal(Buffer.from(secret), { userId: owner, provider, keyId, version: 1 });
    await pool.query(
      `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
       values ($1, $2, $3, $4, 1, $5, $6, $7, $8, 'cdef', $9, 1)`,
      [keyId, owner, provider, status, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.kekVersion, randomBytes(32).toString('hex')],
    );
  }
  const campaign = randomUUID();
  const brief = randomUUID();
  await pool.query(
    `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'Calm Morning Drink', 'A slow morning drink that makes the start of the day calmer', $3)`,
    [campaign, owner, segments],
  );
  await pool.query(
    `insert into drafts (id, owner_id, step, product_name, product_description, segment_count, campaign_id) values ($1, $2, 5, 'Calm Morning Drink', 'A slow morning drink that makes the start of the day calmer', $3, $4)`,
    [randomUUID(), owner, segments, campaign],
  );
  await pool.query(`insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, 'accepted', now())`, [brief, campaign, owner]);
  for (let position = 1; position <= segments; position += 1) {
    await pool.query(
      `insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), brief, position, DIALOGUE[position], `Segment ${position}: a bright kitchen at dawn, the drink poured slowly`, DIALOGUE[position].split(' ').length],
    );
  }
  if (reservedUsd !== undefined) {
    // Spend already reserved today by another job of this account: the next clip would pass the daily cap.
    await pool.query(
      `insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) values ($1, $2, 'video', $3, $4, 1)`,
      [randomUUID(), owner, randomUUID(), reservedUsd],
    );
  }
  return { owner, campaign, dialogue: DIALOGUE.slice(1, segments + 1) };
}

async function stateOf(campaign) {
  const jobs = (
    await pool.query(
      `select s.position, j.state, j.cause_class, j.call_count, j.created_at,
              (select qc_state from qc_runs q where q.video_job_id = j.id order by q.created_at desc limit 1) as qc_state
         from video_jobs j join brief_segments s on s.id = j.segment_id
        where j.campaign_id = $1 order by s.position, j.created_at`,
      [campaign],
    )
  ).rows;
  return { jobs };
}

const readJson = (req) =>
  new Promise((resolveBody) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolveBody(parts.length === 0 ? {} : JSON.parse(Buffer.concat(parts).toString())));
  });

const control = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://control');
  const send = (status, value) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  try {
    if (req.method === 'GET' && url.pathname === '/ready') return send(200, { ready: true });
    if (req.method === 'POST' && url.pathname === '/seed') return send(200, await seed(await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/behaviour') {
      const b = await readJson(req);
      if (b.failOnce) behaviour.failOnce = new Set(b.failOnce);
      if (b.qcMismatch) behaviour.qcMismatch = new Set(b.qcMismatch);
      if (b.submit) behaviour.submit = b.submit;
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/calls/reset') {
      calls.length = 0;
      return send(200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/calls') return send(200, { calls });
    if (req.method === 'GET' && url.pathname === '/state') return send(200, await stateOf(url.searchParams.get('campaign')));
    if (req.method === 'GET' && url.pathname === '/logs') return send(200, { lines });
    return send(404, { error: 'not found' });
  } catch (error) {
    return send(500, { error: String(error) });
  }
});
await new Promise((r) => control.listen(CONTROL_PORT, '127.0.0.1', r));

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  control.close();
  await worker.runtime.drain().catch(() => undefined);
  await worker.context.close().catch(() => undefined);
  await apiBoss.stop({ graceful: false }).catch(() => undefined);
  await pool.end().catch(() => undefined);
  await new Promise((r) => bucketServer.close(r));
  await stub.close();
  rmSync(clipDir, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
