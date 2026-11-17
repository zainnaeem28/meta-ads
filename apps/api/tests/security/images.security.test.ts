import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropSensitiveSentences } from '../../src/modules/brief/application/worker/post-process.js';
import { runImageAnalysis, seedSubject, uploadImage } from './support/data.js';
import { APP_BUCKET, bootStack, rowsHolding, silentJobLog } from './support/stack.js';
import type { Account, Stack } from './support/stack.js';

// TASK-116: SECT-PD-15 (adversarial analysis output dropped before storage), SECT-PD-05/UP-05 end to end for TC-ZT-10: a
// person's likeness image goes up through the real API, is sanitized by the real worker, is sent to the provider as bytes
// only, yields no inferred attribute in any store, and is erased with the account.

const rules = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'config', 'brand-rules.json'), 'utf8')) as { sensitiveAttributeFilter: { terms: string[] } };
const TERMS = rules.sensitiveAttributeFilter.terms;
const CLEAN_1 = 'A small amber glass bottle with a silver cap.';
const CLEAN_2 = 'The box is matte green.';

let s: Stack;
let boss: Account;
let u: Account;

beforeAll(async () => {
  s = await bootStack('t116img');
  boss = await s.admin('imgboss');
  u = await s.account('imgperson');
  await seedSubject(s, u, 'imgs0001');
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe('analysis output with no sensitive inference (SECT-PD-15, REQ-006, NFR-09)', () => {
  it('drops every sentence that carries a word of the sensitive-attribute list, through the real worker, before it is stored', async () => {
    expect(TERMS.length).toBeGreaterThan(20);
    // The model's answer is capped at 1500 characters, so the list goes through in batches.
    const batches: string[][] = [[]];
    for (const term of TERMS) {
      const current = batches[batches.length - 1] as string[];
      if (current.reduce((n, t) => n + t.length + 40, 0) > 1100) batches.push([term]);
      else current.push(term);
    }
    for (const batch of batches) {
      const hostile = batch.map((term) => `The person shown looks ${term} in the photo.`);
      const done = await runImageAnalysis(s, u, [CLEAN_1, ...hostile, CLEAN_2].join(' '));
      expect(done.state).toBe('completed');
      expect(done.resultText).toBe(`${CLEAN_1} ${CLEAN_2}`);
    }
    // Nothing else of the answers is stored anywhere: the person sentence appears in no table or log.
    expect(await rowsHolding(s.pool, 'The person shown looks', ['public', 'pgboss'])).toEqual({});
    expect(s.logs.join('')).not.toContain('The person shown looks');
  });

  it('refuses an answer with fields beyond the description (age, ethnicity, health, a URL): the job fails and none of it is stored', async () => {
    const media = await s.one<{ id: string }>(`select id from media_objects where owner_id = $1 and kind = 'upload' limit 1`, [u.id]);
    const key = await s.one<{ id: string; version: number }>(`select id, version from provider_keys where owner_id = $1`, [u.id]);
    s.openai.reply = () => ({ body: { choices: [{ message: { role: 'assistant', refusal: null, content: JSON.stringify({ productDescription: `${CLEAN_1} ${CLEAN_2}`, age: 'about 30', ethnicity: 'inferred-ethnicity-canary', health: 'inferred-health-canary', url: 'https://evil.example.com/x' }) } }] } });
    const jobId = (await s.one<{ id: string }>(`select gen_random_uuid() as id`)).id;
    await s.pool.query(`insert into brief_jobs (id, owner_id, kind, media_id, state, reuse_hash, key_id, key_version, deadline_at) values ($1, $2, 'image_analysis', $3, 'pending', repeat('e', 64), $4, $5, now() + interval '10 minutes')`, [jobId, u.id, media.id, key.id, key.version]);
    await s.boss.send('brief.analyze-image', { jobId });
    await s.until(async () => ['completed', 'failed'].includes((await s.one<{ state: string }>(`select state from brief_jobs where id = $1`, [jobId])).state), 'the job', 60_000);
    const row = await s.one<Record<string, unknown>>(`select * from brief_jobs where id = $1`, [jobId]);
    expect(row['state']).toBe('failed');
    expect(row['result_text']).toBeNull();
    for (const canary of ['inferred-ethnicity-canary', 'inferred-health-canary', 'evil.example.com', 'about 30']) {
      expect(await rowsHolding(s.pool, canary, ['public', 'pgboss']), canary).toEqual({});
      expect(s.logs.join('').includes(canary), canary).toBe(false);
    }
  });

  it('drops the wordings an evasion would use: case, punctuation, line breaks and list items', () => {
    const probes = [
      'AN ELDERLY MAN holds the jar.', 'The jar sits next to a Black woman!', 'Held by an asian teenager?', 'A pregnant model smiles.\nThe lid is silver.',
      'A diabetic patient in a wheelchair.', 'Looks healthy and young, in her twenties', '- hispanic couple\n- amber bottle',
    ];
    const bad = probes.filter((text) => {
      const kept = dropSensitiveSentences(text, TERMS);
      return /elderly|black|asian|teen|pregnant|diabetic|wheelchair|healthy|young|twenties|hispanic/iu.test(kept);
    });
    expect(bad, 'sentences that kept a sensitive wording').toEqual([]);
  });
});

describe('a person\'s likeness image end to end (TC-ZT-10, NFR-09, SECT-UP-05, SECT-PD-02)', () => {
  it('is stored privately without EXIF or GPS, goes to the provider as bytes only, and is erased with the account', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 120, b: 90 } } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'exif-owner-canary-116' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '0/1 7/1 0/1' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const seededQuarantine = new Set([...s.stand.objects.keys()].filter((name) => name.startsWith(`${APP_BUCKET}/q/${u.id}/`)));
    const up = await uploadImage(s, u, jpeg);
    expect(up.status, JSON.stringify(up.body)).toBeLessThan(300);
    const mediaId = up.body.data?.id as string;
    await s.until(async () => (await s.one<{ state: string }>(`select state from media_objects where id = $1`, [mediaId])).state === 'ready', 'the image to be ready', 60_000);
    const row = await s.one<{ storage_key: string; owner_id: string }>(`select storage_key, owner_id from media_objects where id = $1`, [mediaId]);
    // Private by construction: the object lives under the owner's own prefix, the file name the client sent is not in the key,
    // and an unsigned request is the bucket's to refuse (SECT-R2-03 is a deploy check).
    expect(row.storage_key.startsWith(`u/${u.id}/`)).toBe(true);
    expect(row.storage_key).not.toMatch(/passwd|\.\.|etc/);
    const stored = s.stand.objects.get(`${APP_BUCKET}/${row.storage_key}`) as Buffer;
    expect(stored.includes(Buffer.from('Exif'))).toBe(false);
    expect(stored.includes(Buffer.from('exif-owner-canary-116'))).toBe(false);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    // No upload of the person's image leaves a copy outside the owner's prefixes (the quarantine object is gone).
    expect([...s.stand.objects.keys()].filter((name) => name.startsWith(`${APP_BUCKET}/q/${u.id}/`) && !seededQuarantine.has(name))).toEqual([]);
    // The provider gets the sanitized bytes inline: no URL of the image, no EXIF.
    const key = await s.one<{ id: string; version: number }>(`select id, version from provider_keys where owner_id = $1`, [u.id]);
    s.openai.reply = () => ({ body: { choices: [{ message: { role: 'assistant', refusal: null, content: JSON.stringify({ productDescription: CLEAN_1 }) } }] } });
    const jobId = (await s.one<{ id: string }>(`select gen_random_uuid() as id`)).id;
    await s.pool.query(`insert into brief_jobs (id, owner_id, kind, media_id, state, reuse_hash, key_id, key_version, deadline_at) values ($1, $2, 'image_analysis', $3, 'pending', repeat('f', 64), $4, $5, now() + interval '10 minutes')`, [jobId, u.id, mediaId, key.id, key.version]);
    s.openai.seen.length = 0;
    await s.boss.send('brief.analyze-image', { jobId });
    await s.until(async () => (await s.one<{ state: string }>(`select state from brief_jobs where id = $1`, [jobId])).state === 'completed', 'the analysis', 60_000);
    const sent = JSON.stringify(s.openai.seen[0]?.body);
    expect(sent).not.toMatch(/https?:\/\//u);
    const dataUrl = /data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/u.exec(sent);
    expect(dataUrl).not.toBeNull();
    const provided = Buffer.from(dataUrl?.[1] ?? '', 'base64');
    expect(provided.includes(Buffer.from('exif-owner-canary-116'))).toBe(false);
    expect((await sharp(provided).metadata()).exif).toBeUndefined();
    // Erased on removal (TC-DEL-05): the object, the row and the description go.
    const removed = await s.call('POST', `/admin/users/${u.id}/remove`, boss.token, { confirmation: u.email });
    expect(removed.status).toBe(202);
    const runId = removed.body.data.deletionRunId as string;
    await s.until(async () => (await s.one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step === 4, 'step 4');
    await s.pool.query(`update deletion_runs set not_before = now() where id = $1`, [runId]);
    expect(await s.erasure.run(runId, silentJobLog)).toBe('completed');
    expect(s.stand.objects.has(`${APP_BUCKET}/${row.storage_key}`)).toBe(false);
    expect([...s.stand.objects.keys()].filter((name) => name.includes(u.id) && name.startsWith(`${APP_BUCKET}/`))).toEqual([]);
    expect(await s.count('media_objects', 'owner_id = $1', [u.id])).toBe(0);
    expect(await s.count('brief_jobs', 'owner_id = $1', [u.id])).toBe(0);
    expect(await rowsHolding(s.pool, CLEAN_1, ['public', 'pgboss'])).toEqual({});
  });
});
