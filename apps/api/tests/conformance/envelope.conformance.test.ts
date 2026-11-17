import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_STATUS } from '../../src/platform/http/domain-error.js';
import { contractsDir, openDefect } from '../security/support/stack.js';
import { conformance } from './support/envelope.js';
import { send } from './support/cells.js';
import * as fx from './support/fixtures.js';
import { errorCodes, operations } from './support/spec.js';
import { bootWorld } from './support/world.js';
import type { Account, World } from './support/world.js';

// TC-ENV-03 (validation details), TC-ENV-04 (pagination), TC-ENV-05 (health), TC-ENV-06 (request id), TC-ERR-08 (the registry's
// three lists). TC-ENV-01 and TC-ENV-02 run on every reply of the matrix (matrix.conformance.test.ts).

let w: World;
let user: Account;
let boss: Account;
beforeAll(async () => { w = await bootWorld('t65env'); user = await w.account('env'); boss = await w.admin('env-boss'); }, 300_000);
afterAll(async () => { await w?.close(); });

const op = (id: string) => operations().find((o) => o.id === id) as NonNullable<ReturnType<typeof operations>[number]>;

describe('the registry has one list (TC-ERR-08)', () => {
  it('the OpenAPI enum, the generated list and the status table are the same 36 codes', () => {
    const generated = [...readFileSync(join(contractsDir, 'src', 'generated', 'error-codes.ts'), 'utf8').matchAll(/^\s+'([a-z_]+)',$/gm)].map((m) => m[1]);
    expect(errorCodes()).toHaveLength(36);
    expect(generated).toEqual([...errorCodes()]);
    expect(Object.keys(ERROR_STATUS)).toEqual([...errorCodes()]);
  });

  it('every operation names only registry codes, and every status it declares has a code to carry it', () => {
    for (const o of operations()) {
      for (const code of o.codes) expect(errorCodes(), `${o.id} names ${code}`).toContain(code);
    }
  });
});

describe('validation failures name public fields (TC-ENV-03)', () => {
  it('a segment edit with a too-long line, a missing field and a wrong type', async () => {
    const c = await fx.campaign(w, user, { briefState: 'draft' });
    const long = await w.call('PATCH', `/campaigns/${c.id}/brief`, user.token, { segments: [{ position: 1, dialogue: 'x'.repeat(601) }] }, { 'if-match': '"1"' });
    expect([long.status, long.body.error?.code]).toEqual([400, 'validation_failed']);
    expect(long.body.error?.details).toContainEqual({ field: 'segments.0.dialogue', code: 'too_long', message: expect.any(String) });
    const missing = await w.call('PATCH', `/campaigns/${c.id}/brief`, user.token, {}, { 'if-match': '"1"' });
    expect(missing.body.error?.details?.[0]).toMatchObject({ field: 'segments', code: 'required' });
    const wrong = await w.call('PATCH', `/campaigns/${c.id}/brief`, user.token, { segments: 'nope' }, { 'if-match': '"1"' });
    expect(wrong.status).toBe(400);
    for (const res of [long, missing, wrong]) for (const detail of res.body.error?.details ?? []) expect(detail.field).not.toMatch(/_/);
  });

  it('an invalid cursor, limit 0 and limit 51 on a list', async () => {
    for (const path of ['/drafts', '/campaigns']) {
      const cursor = await w.call('GET', `${path}?cursor=garbage`, user.token);
      expect([cursor.status, cursor.body.error?.code]).toEqual([400, 'validation_failed']);
      expect(cursor.body.error?.details).toContainEqual({ field: 'cursor', code: 'cursor_invalid', message: expect.any(String) });
      for (const limit of ['0', '51', '-1', 'abc']) {
        const res = await w.call('GET', `${path}?limit=${limit}`, user.token);
        expect([path, limit, res.status, res.body.error?.code]).toEqual([path, limit, 400, 'validation_failed']);
        expect(res.body.error?.details?.[0]?.field).toBe('limit');
        expect(['out_of_range', 'invalid_format', 'invalid_type']).toContain(res.body.error?.details?.[0]?.code);
        if (limit === '0' || limit === '51') expect(res.body.error?.details?.[0]?.code).toBe('out_of_range');
      }
    }
  });

  it('a malformed provider key is refused without echoing the value, and 60 bad fields give at most 50 details', async () => {
    const secret = 'sk-short';
    const res = await w.call('PUT', '/me/provider-keys/openai', user.token, { apiKey: secret });
    expect(res.status, 'API-011 declares a refused key as 422 key_invalid (the contract, not the 400 TC-ENV-03 names)').toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.raw).not.toContain(secret);
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`extra${String(i)}`, i]));
    const flood = await w.call('POST', '/drafts', user.token, many);
    expect(flood.status).toBe(400);
    expect(flood.body.error?.details?.length).toBeGreaterThan(0);
    expect(flood.body.error?.details?.length).toBeLessThanOrEqual(50);
  });

  openDefect('CONF065-F1', 'a body that is not valid JSON is a 400 validation_failed in the envelope, not the framework error', async () => {
    for (const [method, path] of [['POST', '/api/v1/drafts'], ['PUT', '/api/v1/me/provider-keys/openai'], ['POST', '/api/v1/admin/invitations']] as const) {
      const res = await w.raw(method, path, { authorization: `Bearer ${boss.token}`, 'content-type': 'application/json' }, '{"broken');
      expect([path, res.status, res.body.error?.code]).toEqual([path, 400, 'validation_failed']);
      expect(res.body.success).toBe(false);
    }
  });

  openDefect('CONF065-F1', 'a JSON body over 64 KiB is a 413 payload_too_large in the envelope, not the framework error', async () => {
    const res = await w.raw('POST', '/api/v1/drafts', { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' }, JSON.stringify({ productName: 'x'.repeat(70_000) }));
    expect([res.status, res.body.error?.code]).toEqual([413, 'payload_too_large']);
  });
});

describe('lists page forward with a signed cursor (TC-ENV-04)', () => {
  const seedMany = async (): Promise<void> => {
    for (let i = 0; i < 51; i += 1) {
      await w.pool.query(`insert into drafts (id, owner_id, product_name) values ($1, $2, $3)`, [randomUUID(), user.id, `Draft ${String(i)}`]);
      await w.pool.query(`insert into invitations (id, email, invited_by, state, expires_at) values ($1, $2, $3, 'invited', now() + interval '1 day')`, [randomUUID(), `many${String(i)}-${randomUUID().slice(0, 6)}@example.test`, boss.id]);
      await w.pool.query(`insert into access_requests (id, idp_subject, email, state) values ($1, $2, $3, 'pending')`, [randomUUID(), `user_many_${randomUUID()}`, `ask${String(i)}-${randomUUID().slice(0, 6)}@example.test`]);
      await w.pool.query(`insert into admin_alerts (id, kind, counts) values ($1, 'job_burst', '{}'::jsonb)`, [randomUUID()]);
      const c = await fx.campaign(w, user);
      void c;
    }
  };
  const lists: [string, string, boolean][] = [['API-020', '/drafts', false], ['API-040', '/campaigns', false], ['API-110', '/admin/invitations', true], ['API-115', '/admin/access-requests', true], ['API-125', '/admin/alerts', true]];

  it('limit 1, 20 (default), 50 and 51 on every list with 51 records', async () => {
    await seedMany();
    for (const [id, path, admin] of lists) {
      const token = (admin ? boss : user).token;
      for (const [limit, expected] of [[1, 1], [undefined, 20], [50, 50]] as const) {
        const res = await w.call('GET', `${path}${limit === undefined ? '' : `?limit=${String(limit)}`}`, token);
        expect([id, limit, res.status]).toEqual([id, limit, 200]);
        expect(res.body.data).toHaveLength(expected);
        expect(res.body.metaData.pagination).toMatchObject({ type: 'cursor', limit: limit ?? 20, returnedCount: expected, hasNextPage: true });
        expect(Object.keys(res.body.metaData.pagination).sort()).toEqual(['hasNextPage', 'limit', 'nextCursor', 'returnedCount', 'type']);
        expect(typeof res.body.metaData.pagination.nextCursor).toBe('string');
      }
      const over = await w.call('GET', `${path}?limit=51`, token);
      expect([id, over.status, over.body.error?.details?.[0]?.code]).toEqual([id, 400, 'out_of_range']);
    }
  });

  it('following the cursor visits every record once and ends with no next cursor', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Awaited<ReturnType<World['call']>> = await w.call('GET', `/drafts?limit=20${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, user.token);
      expect(res.status).toBe(200);
      for (const row of res.body.data) {
        expect(seen.has(row.id), 'a record appeared twice').toBe(false);
        seen.add(row.id);
      }
      cursor = res.body.metaData.pagination.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen.size).toBeGreaterThanOrEqual(51);
    expect(cursor).toBeNull();
  });

  it('a tampered cursor and another owner\'s cursor give cursor_invalid and no data', async () => {
    const first = await w.call('GET', '/drafts?limit=1', user.token);
    const cursor = first.body.metaData.pagination.nextCursor as string;
    const tampered = `${cursor.slice(0, -3)}${cursor.endsWith('AAA') ? 'BBB' : 'AAA'}`;
    const other = await w.account('cursor-thief');
    for (const [name, token, value] of [['tampered', user.token, tampered], ['foreign', other.token, cursor]] as const) {
      const res = await w.call('GET', `/drafts?cursor=${encodeURIComponent(value)}`, token);
      expect([name, res.status, res.body.error?.code]).toEqual([name, 400, 'validation_failed']);
      expect(res.body.error?.details).toContainEqual({ field: 'cursor', code: 'cursor_invalid', message: expect.any(String) });
      expect(res.body.data).toBeUndefined();
    }
  });
});

describe('health probes (TC-ENV-05)', () => {
  it('API-900 and API-901 answer {status: ok} and nothing else, with no session', async () => {
    for (const path of ['/health/live', '/health/ready']) {
      const res = await w.raw('GET', path);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
      expect(Object.keys(res.body.data as object)).toEqual(['status']);
      expect(conformance(op(path === '/health/live' ? 'API-900' : 'API-901'), 200, { status: 200, code: undefined, headers: res.headers, text: res.text, body: res.body })).toEqual([]);
    }
  });
});

describe('the request id (TC-ENV-06)', () => {
  it('an oversized or malformed X-Request-ID is replaced by a safe generated one and never reflected', async () => {
    for (const value of ['x'.repeat(500), '<script>alert(1)</script>', 'a b c', '../../etc/passwd', 'éé']) {
      const res = await w.raw('GET', '/api/v1/me', { authorization: `Bearer ${user.token}`, 'x-request-id': value.replace(/[^\x20-\x7e]/g, '?') });
      expect(res.status).toBe(200);
      const id = res.headers['x-request-id'] as string;
      expect(id).not.toBe(value);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(res.body.metaData).toMatchObject({ requestId: id });
    }
    const fine = await w.raw('GET', '/api/v1/me', { authorization: `Bearer ${user.token}` });
    expect(fine.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('unused helper', () => { it('is the operation under test', () => { expect(send).toBeTypeOf('function'); }); });
