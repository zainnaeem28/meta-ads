import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { OPENAI_CANARY, contractsDir } from './stack.js';
import type { Account, Stack } from './stack.js';

/** The canaries of one synthetic subject: strings no product code or fixture produces by chance. */
export interface Canaries {
  readonly productName: string;
  readonly productText: string;
  readonly dialogue: string;
  readonly prompt: string;
  readonly description: string;
  readonly transcript: string;
}

export function canaries(tag: string): Canaries {
  return {
    productName: `Canary Cap ${tag}`,
    productText: `A slow morning drink canary-product-${tag}`,
    dialogue: `canary-dialogue-${tag} wakes the calm kitchen`,
    prompt: `canary-prompt-${tag} in a quiet window`,
    description: `canary-description-${tag} amber bottle with a silver cap`,
    transcript: `canary-transcript-${tag} spoken line`,
  };
}

export interface Seeded {
  readonly account: Account;
  readonly canaries: Canaries;
  readonly campaign: string;
  readonly media: string[];
  readonly upload: string;
  readonly objects: string[];
  readonly briefJob: string;
}

/**
 * One synthetic subject with data in every class of PRD §3.3: a provider key (through API-011 with the canary key), a campaign
 * with draft, brief and segments, a clip, an uploaded likeness image, a quarantine object, an image-analysis result, a usage
 * event, an access request and an invitation they sent.
 */
export async function seedSubject(stack: Stack, account: Account, tag: string): Promise<Seeded> {
  const c = canaries(tag);
  const { pool, storage } = stack;
  stack.probe.answer = 200;
  const key = await stack.call('PUT', '/me/provider-keys/openai', account.token, { apiKey: `${OPENAI_CANARY}-${tag}` });
  if (key.status !== 200) throw new Error(`key entry failed: ${String(key.status)} ${key.raw}`);
  const campaign = randomUUID();
  const brief = randomUUID();
  await pool.query(
    `insert into campaigns (id, owner_id, state, product_name, product_description, segment_count) values ($1, $2, 'active', $3, $4, 2)`,
    [campaign, account.id, c.productName, c.productText],
  );
  await pool.query(`insert into drafts (id, owner_id, campaign_id, product_name, concept) values ($1, $2, $3, $4, $5)`, [randomUUID(), account.id, campaign, c.productName, c.productText]);
  await pool.query(`insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, 'accepted', now())`, [brief, campaign, account.id]);
  for (const position of [1, 2]) {
    await pool.query(`insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, $3, $4, $5, 30)`, [randomUUID(), brief, position, `${c.dialogue} ${String(position)}`, c.prompt]);
  }
  const media: string[] = [];
  const objects: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const id = randomUUID();
    const storageKey = `u/${account.id}/c/${campaign}/clip/${id}.mp4`;
    await storage.put(storageKey, Buffer.alloc(64, 1), 'video/mp4', 1000);
    await pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, 'clip', 'ready', $3, 64, 'video/mp4', $4)`, [id, account.id, storageKey, campaign]);
    media.push(id);
    objects.push(storageKey);
  }
  // The likeness image upload (NFR-09): a private object under the owner's prefix.
  const upload = randomUUID();
  const uploadKey = `u/${account.id}/media/${upload}`;
  await storage.put(uploadKey, Buffer.alloc(32, 9), 'image/png', 1000);
  await pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height) values ($1, $2, 'upload', 'ready', $3, 32, 'image/png', 1, 1)`, [upload, account.id, uploadKey]);
  objects.push(uploadKey);
  const quarantine = `q/${account.id}/${randomUUID()}.bin`;
  await storage.put(quarantine, Buffer.alloc(16, 4), 'application/octet-stream', 100);
  objects.push(quarantine);
  await pool.query(`insert into storage_usage (owner_id, bytes_used) values ($1, 96) on conflict (owner_id) do update set bytes_used = 96`, [account.id]);
  const keyRow = await stack.one<{ id: string }>(`select id from provider_keys where owner_id = $1`, [account.id]);
  const briefJob = randomUUID();
  await pool.query(
    `insert into brief_jobs (id, owner_id, kind, media_id, state, reuse_hash, key_id, key_version, result_text, deadline_at)
     values ($1, $2, 'image_analysis', $3, 'completed', $4, $5, 1, $6, now() + interval '10 minutes')`,
    [briefJob, account.id, upload, randomBytes(32).toString('hex'), keyRow.id, c.description],
  );
  await pool.query(
    `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis) values ($1, $2, 'openai', 'local-stub-vision', 'image_analysis', $3, 1, 'succeeded', 0.01, 'estimate')`,
    [randomUUID(), account.id, briefJob],
  );
  await pool.query(`insert into access_requests (id, idp_subject, email, state) values ($1, $2, $3, 'pending')`, [randomUUID(), account.sub, account.email]);
  const providerInvitation = await stack.workerIdentity.createInvitation(account.email, 7);
  await pool.query(`update invitations set idp_invitation_id = $2, state = 'invited', accepted_user_id = null where lower(email) = $1`, [account.email, providerInvitation]);
  const sent = randomUUID();
  await pool.query(`insert into invitations (id, email, invited_by, state, expires_at) values ($1, $2, $3, 'invited', now() + interval '1 day')`, [sent, `sent-${sent.slice(0, 8)}.person@example.test`, account.id]);
  return { account, canaries: c, campaign, media, upload, objects, briefJob };
}

interface OperationEntry {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly scopes: string[];
}

/** Every operation of the OpenAPI file with its stable ID, method, path template and `x-scope` (the ticket's own generated matrix). */
export function openApiOperations(): OperationEntry[] {
  const requireFromContracts = createRequire(join(contractsDir, 'package.json'));
  const yaml = requireFromContracts('js-yaml') as { load(text: string): { paths: Record<string, Record<string, Record<string, unknown>>> } };
  const spec = yaml.load(readFileSync(join(contractsDir, 'openapi.yaml'), 'utf8'));
  const out: OperationEntry[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const scope = String(op['x-scope'] ?? '');
      out.push({ id: String(op['x-api-id'] ?? ''), method: method.toUpperCase(), path, scopes: scope.split(',').map((s) => s.trim()).filter((s) => s !== '') });
    }
  }
  return out;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a52e5ad90000000049454e44ae426082', 'hex');

export const completion = (content: unknown) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content), refusal: null } }] });

/**
 * Runs `brief.analyze-image` through the real worker for one owner: a ready image in storage, a pending job with the owner's
 * sealed key, the queue message, and waits for the terminal row. The vision model's answer is `answer`.
 */
export async function runImageAnalysis(stack: Stack, owner: Account, answer: string): Promise<{ state: string; resultText: string | null; jobId: string }> {
  const media = randomUUID();
  const storageKey = `u/${owner.id}/media/${media}`;
  await stack.storage.put(storageKey, PNG, 'image/png', PNG.length);
  await stack.pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height) values ($1, $2, 'upload', 'ready', $3, $4, 'image/png', 1, 1)`, [media, owner.id, storageKey, PNG.length]);
  const key = await stack.one<{ id: string; version: number }>(`select id, version from provider_keys where owner_id = $1 and provider = 'openai' and status = 'active'`, [owner.id]);
  const jobId = randomUUID();
  await stack.pool.query(
    `insert into brief_jobs (id, owner_id, kind, media_id, state, reuse_hash, key_id, key_version, deadline_at) values ($1, $2, 'image_analysis', $3, 'pending', $4, $5, $6, now() + interval '10 minutes')`,
    [jobId, owner.id, media, randomBytes(32).toString('hex'), key.id, key.version],
  );
  stack.openai.reply = () => ({ body: completion({ productDescription: answer }) });
  await stack.boss.send('brief.analyze-image', { jobId });
  let row: { state: string; result_text: string | null } | undefined;
  await stack.until(async () => {
    row = await stack.one<{ state: string; result_text: string | null }>(`select state, result_text from brief_jobs where id = $1`, [jobId]);
    return ['completed', 'failed', 'cancelled'].includes(row.state);
  }, 'the image analysis job', 60_000);
  if ((row as { state: string }).state !== 'completed') console.log('image analysis ended', JSON.stringify(await stack.one(`select state, cause_class, cause_message, last_error_code from brief_jobs where id = $1`, [jobId])));
  return { state: (row as { state: string }).state, resultText: (row as { result_text: string | null }).result_text, jobId };
}

/** POST /media with a multipart body holding `file` (the part named `file`). */
export async function uploadImage(stack: Stack, owner: Account, file: Buffer) {
  const boundary = `----t116${randomBytes(6).toString('hex')}`;
  const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../etc/passwd.jpg"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const res = await stack.app.getHttpAdapter().getInstance().inject({
    method: 'POST',
    url: '/api/v1/media',
    headers: { authorization: `Bearer ${owner.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([pre, file, post]),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as { data?: { id: string; state: string }; error?: { code: string } } };
}
