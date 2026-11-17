import { createHash, randomUUID } from 'node:crypto';
import { FAKE_KEY, WAVE_KEY } from './requests.js';
import type { Account, World } from './world.js';

// Rows the matrix needs in a state the API cannot reach quickly (a finished clip, an accepted brief, a stored image). They are
// written with SQL the way the product's own integration suites write them; everything the cell then asserts goes through HTTP.

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

export async function putKey(
  w: World,
  who: Account,
  provider: 'openai' | 'wavespeed' = 'openai',
): Promise<void> {
  w.probe.answer = 200;
  const res = await w.call('PUT', `/me/provider-keys/${provider}`, who.token, {
    apiKey: provider === 'openai' ? FAKE_KEY : WAVE_KEY,
  });
  if (res.status !== 200) throw new Error(`key entry failed: ${String(res.status)} ${res.raw}`);
}

export interface Campaign {
  readonly id: string;
  readonly briefId: string;
  /** The draft the campaign came from (a submitted draft). */
  readonly draftId: string;
  /** Segment ids by position (1..count). */
  readonly segments: string[];
}

export async function campaign(
  w: World,
  who: Account,
  opts: { briefState?: 'draft' | 'accepted' | 'generating'; segments?: number } = {},
): Promise<Campaign> {
  const id = randomUUID();
  const briefId = randomUUID();
  const count = opts.segments ?? 2;
  const state = opts.briefState ?? 'accepted';
  await w.pool.query(
    `insert into campaigns (id, owner_id, state, product_name, product_description, segment_count) values ($1, $2, 'active', 'Conformance Cap', 'A calm morning drink', $3)`,
    [id, who.id, count],
  );
  await w.pool.query(
    `insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, $4, $5)`,
    [briefId, id, who.id, state, state === 'accepted' ? new Date() : null],
  );
  const segments: string[] = [];
  for (let position = 1; position <= count; position += 1) {
    const segment = randomUUID();
    await w.pool.query(
      `insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, $3, $4, $5, 30)`,
      [segment, briefId, position, `Line number ${String(position)} of the ad.`, 'A quiet window.'],
    );
    segments.push(segment);
  }
  // The campaign list and detail read a campaign through the draft it came from.
  const draftId = randomUUID();
  await w.pool.query(
    `insert into drafts (id, owner_id, campaign_id, product_name, concept) values ($1, $2, $3, 'Conformance Cap', 'A calm morning')`,
    [draftId, who.id, id],
  );
  return { id, briefId, draftId, segments };
}

/** A ready object of the owner, in the store and in the table. */
export async function media(
  w: World,
  who: Account,
  kind: 'upload' | 'clip' | 'thumbstopper' | 'assembly' = 'upload',
  state: 'ready' | 'processing' = 'ready',
  campaignId?: string,
): Promise<string> {
  const id = randomUUID();
  const storageKey =
    kind === 'upload'
      ? `u/${who.id}/media/${id}`
      : `u/${who.id}/c/${campaignId ?? 'x'}/${kind}/${id}`;
  await w.storage.put(
    storageKey,
    Buffer.alloc(32, 1),
    kind === 'upload' ? 'image/png' : 'video/mp4',
    32,
  );
  await w.pool.query(
    kind === 'upload'
      ? `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height) values ($1, $2, 'upload', $4, $3, 32, 'image/png', 1, 1)`
      : `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, '${kind}', $4, $3, 32, 'video/mp4', '${campaignId ?? randomUUID()}')`,
    [id, who.id, storageKey, state],
  );
  return id;
}

/** A video job of a segment: `completed` has its clip, `failed` and `cancelled` are what API-063 can retry. */
export async function videoJob(
  w: World,
  who: Account,
  c: Campaign,
  position = 1,
  state: 'completed' | 'failed' | 'cancelled' | 'processing' = 'completed',
): Promise<string> {
  const id = randomUUID();
  const output = state === 'completed' ? await media(w, who, 'clip', 'ready', c.id) : null;
  await w.pool.query(
    `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, provider_model, options, output_media_id, state, reuse_hash, deadline_at, cause_class)
     values ($1, $2, $3, $4, 1, 'bytedance/seedance-2.0/text-to-video', '{}'::jsonb, $5, $6, $7, now() + interval '10 minutes', $8)`,
    [
      id,
      who.id,
      c.id,
      c.segments[position - 1],
      output,
      state,
      hash(id),
      state === 'failed'
        ? 'temporary'
        : state === 'cancelled'
          ? 'cancelled_campaign_deleted'
          : null,
    ],
  );
  return id;
}

export async function qcRun(
  w: World,
  who: Account,
  jobId: string,
  qcState: 'passed' | 'failed' | 'skipped' | 'pending',
): Promise<void> {
  await w.pool.query(
    `insert into qc_runs (id, owner_id, video_job_id, qc_state, state, reuse_hash, deadline_at) values ($1, $2, $3, $4, 'completed', $5, now() + interval '10 minutes')`,
    [randomUUID(), who.id, jobId, qcState, hash(`qc${jobId}${qcState}`)],
  );
}

export async function thumbstopper(
  w: World,
  who: Account,
  c: Campaign,
  state: 'completed' | 'pending' = 'completed',
): Promise<string> {
  const id = randomUUID();
  const output = state === 'completed' ? await media(w, who, 'thumbstopper', 'ready', c.id) : null;
  await w.pool.query(
    `insert into thumbstopper_jobs (id, owner_id, campaign_id, callout_text, provider_model, output_media_id, state, reuse_hash, deadline_at) values ($1, $2, $3, 'Fresh', 'local-stub-image', $4, $5, $6, now() + interval '10 minutes')`,
    [id, who.id, c.id, output, state, hash(id)],
  );
  return id;
}

export async function assemblyJob(
  w: World,
  who: Account,
  c: Campaign,
  clipJob: string,
): Promise<string> {
  const id = randomUUID();
  await w.pool.query(
    `insert into assembly_jobs (id, owner_id, campaign_id, state, reuse_hash, render_day) values ($1, $2, $3, 'pending', $4, current_date)`,
    [id, who.id, c.id, hash(id)],
  );
  await w.pool.query(
    `insert into assembly_clips (assembly_job_id, position, video_job_id) values ($1, 1, $2)`,
    [id, clipJob],
  );
  return id;
}

export async function claimIssue(
  w: World,
  who: Account,
  c: Campaign,
  cls: 'high_risk' | 'other' = 'other',
): Promise<string> {
  const id = randomUUID();
  await w.pool.query(
    `insert into claim_issues (id, owner_id, brief_id, segment_id, field, rule_id, class, message) values ($1, $2, $3, $4, 'dialogue', 'conformance-rule', $5, 'A claim needs a look.')`,
    [id, who.id, c.briefId, c.segments[0], cls],
  );
  return id;
}

/** Fills today's spend so that the next job-creating call reaches the cap. */
export async function fillSpend(w: World, who: Account, usd = 1000): Promise<void> {
  await w.pool.query(
    `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis) values ($1, $2, 'openai', 'local-stub-text', 'brief_generation', $3, 1, 'succeeded', $4, 'estimate')`,
    [randomUUID(), who.id, randomUUID(), usd],
  );
}

export const invitation = async (
  w: World,
  invitedBy: string | null,
  email = `invited${randomUUID().slice(0, 8)}@example.test`,
  state: 'invited' | 'revoked' | 'expired' = 'invited',
): Promise<string> => {
  const id = randomUUID();
  await w.pool.query(
    `insert into invitations (id, email, invited_by, state, expires_at) values ($1, $2, $3, $4, now() + interval '1 day')`,
    [id, email, invitedBy, state],
  );
  return id;
};

export const accessRequest = async (
  w: World,
  state: 'pending' | 'declined' | 'approved' = 'pending',
  email = `asker${randomUUID().slice(0, 8)}@example.test`,
): Promise<string> => {
  const id = randomUUID();
  await w.pool.query(
    `insert into access_requests (id, idp_subject, email, state) values ($1, $2, $3, $4)`,
    [id, `user_req_${id}`, email, state],
  );
  return id;
};
