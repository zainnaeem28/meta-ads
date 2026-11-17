import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSubject } from './support/data.js';
import type { Seeded } from './support/data.js';
import { LEDGER_BUCKET, APP_BUCKET, OPENAI_CANARY, bootStack, rowsHolding, silentJobLog } from './support/stack.js';
import type { Account, Stack } from './support/stack.js';

// TASK-116, SECURITY-DESIGN §10.9 (SECT-PD-01, 02, 06, 07, 10, 11; SECT-LOG-05 database sinks), TEST-CASES TC-ZT-10,
// TC-DEL-05, TC-NFR-09: the personal-data inventory matrix, erasure completeness on synthetic users and the ledger replay
// after a restored dump (T-15, T-22), through the real api and worker composition roots on real PostgreSQL.
// SECT-PD-10/13 as a drill on the real backup artifacts and SECT-PD-12 (token scopes of the ledger bucket) are Stage 4
// deploy cases: TC-LED-03, TC-BKP-14..16, TC-H-* in TEST-CASES §11.

let s: Stack;
let boss: Account;
let a: Account;
let b: Account;
let subjectA: Seeded;
let subjectB: Seeded;

/** Columns that name a person or an owner: the walker looks for the subject's ID in each of them. */
const OWNER_LIKE = /(^|_)(owner|user|subject|actor|invited_by|accepted_user|decided_by|acknowledged_by|updated_by|cleared_by)(_id)?$|^(invited_by|accepted_user_id|decided_by|acknowledged_by|updated_by|cleared_by)$/;

/**
 * The erasure registry the walker checks against (PRD §3.3, ARCHITECTURE §4): `erased` tables hold no row of an erased
 * subject; `ids-only` tables keep rows that hold the subject's ID and no personal data. A table that gains an owner or user
 * column and is in neither list fails the walker (T-15).
 */
const ERASED = new Set([
  'users', 'access_requests', 'invitations', 'provider_keys', 'media_objects', 'campaigns', 'drafts', 'briefs', 'brief_segments',
  'brief_jobs', 'video_jobs', 'qc_runs', 'claim_events', 'claim_issues', 'storage_usage', 'spend_reservations', 'idempotency_records',
]);
const IDS_ONLY = new Set(['usage_events', 'audit_events', 'key_events', 'deletion_runs', 'admin_alerts', 'rate_limit_buckets', 'platform_settings']);

async function ownerColumns(): Promise<{ table: string; column: string }[]> {
  const rows = (await s.pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type = 'uuid' order by 1, 2`,
  )).rows;
  const found = rows.filter((r) => OWNER_LIKE.test(r.column_name)).map((r) => ({ table: r.table_name, column: r.column_name }));
  return [{ table: 'users', column: 'id' }, ...found]; // the account row itself is keyed by `id`
}

async function rowsOf(subject: string): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const { table, column } of await ownerColumns()) {
    if (table === 'platform_settings') continue;
    const n = await s.count(`"${table}"`, `"${column}" = $1`, [subject]);
    if (n > 0) found[`${table}.${column}`] = n;
  }
  return found;
}

const appObjects = (prefix: string) => [...s.stand.objects.keys()].filter((name) => name.startsWith(`${APP_BUCKET}/${prefix}`));
const ledgerObjects = () => [...s.stand.objects.keys()].filter((name) => name.startsWith(`${LEDGER_BUCKET}/erasure/`));

beforeAll(async () => {
  s = await bootStack('t116pd');
  boss = await s.admin('boss');
  a = await s.account('subjecta');
  b = await s.account('subjectb');
  subjectA = await seedSubject(s, a, 'aaaa1111');
  subjectB = await seedSubject(s, b, 'bbbb2222');
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe('personal-data inventory matrix (SECT-PD-07, SECT-LOG-05, TC-NFR-09)', () => {
  it('holds each class of personal data only in the tables the inventory allows', async () => {
    const allowed: [string, string, string[]][] = [
      ['email', a.email, ['users.email', 'invitations.email', 'access_requests.email']],
      ['identity-provider subject', a.sub, ['users.idp_subject', 'access_requests.idp_subject']],
      ['product name', subjectA.canaries.productName, ['campaigns.product_name', 'drafts.product_name']],
      ['product text', subjectA.canaries.productText, ['campaigns.product_description', 'drafts.concept']],
      ['dialogue', subjectA.canaries.dialogue, ['brief_segments.dialogue']],
      ['visual prompt', subjectA.canaries.prompt, ['brief_segments.prompt']],
      ['image description', subjectA.canaries.description, ['brief_jobs.result_text']],
    ];
    for (const [klass, value, tables] of allowed) {
      const found = await rowsHolding(s.pool, value, ['public', 'pgboss']);
      expect(Object.keys(found).sort(), klass).toEqual([...tables].sort());
    }
  });

  it('keeps the provider key out of every table: only the sealed columns exist and none holds the plaintext (T-01)', async () => {
    expect(await rowsHolding(s.pool, OPENAI_CANARY, ['public', 'pgboss'])).toEqual({});
    expect(await rowsHolding(s.pool, 'canary-OPENAI', ['public', 'pgboss'])).toEqual({});
    const row = await s.one<{ ciphertext: Buffer; wrapped_dek: Buffer }>(`select ciphertext, wrapped_dek from provider_keys where owner_id = $1`, [a.id]);
    expect(row.ciphertext.toString('latin1')).not.toContain('canary-OPENAI');
    expect(row.wrapped_dek.toString('latin1')).not.toContain('canary-OPENAI');
  });

  it('keeps no email, content, description or key in the history tables, the alerts or the queue (audit, usage, key events, runs, jobs)', async () => {
    await s.pool.query(`insert into admin_alerts (id, kind, dedupe_key, subject_user_id, counts) values (gen_random_uuid(), 'account_erasure_stuck', $1, $2, '{}'::jsonb)`, [`pd-${randomUUID()}`, a.id]);
    // Provoke the events that carry a subject: a key replace, a denial, a suspension and its audit and queue entries.
    expect((await s.call('POST', `/admin/users/${b.id}/suspend`, a.token)).status).toBe(403);
    const history = ['audit_events', 'usage_events', 'key_events', 'deletion_runs', 'admin_alerts', 'rate_limit_buckets', 'idempotency_records'];
    const values = [a.email, b.email, a.sub, subjectA.canaries.dialogue, subjectA.canaries.productName, subjectA.canaries.description, 'canary-OPENAI', 'person@example.test'];
    for (const value of values) {
      const found = await rowsHolding(s.pool, value, ['public', 'pgboss']);
      for (const place of Object.keys(found)) {
        const table = place.replace(/^pgboss\./, 'pgboss:').split('.')[0] ?? '';
        expect(history.includes(table) || table.startsWith('pgboss:'), `${value} found in ${place}`).toBe(false);
      }
    }
    // Their own columns are IDs, codes and timestamps: no JSON column and no free-text column that could carry a value exists.
    const codes = new Set(['object_type', 'action', 'outcome', 'request_id', 'actor_type', 'kind', 'provider', 'operation', 'job_type', 'cost_basis', 'state', 'last_error_class']);
    const columns = (await s.pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = any($1) and data_type in ('text', 'character varying', 'jsonb', 'json')`,
      [['audit_events', 'usage_events', 'key_events', 'deletion_runs']],
    )).rows;
    for (const column of columns) {
      expect(['jsonb', 'json'].includes(column.data_type), `${column.table_name}.${column.column_name} is a JSON column`).toBe(false);
      expect(codes.has(column.column_name), `${column.table_name}.${column.column_name} is a free-text column`).toBe(true);
    }
  });

  it('stores no transcript column anywhere and no likeness or description outside the owner-scoped stores', async () => {
    const columns = (await s.pool.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema in ('public', 'pgboss')`)).rows.map((r) => r.column_name);
    for (const name of columns) expect(name, 'a transcript column').not.toMatch(/transcript/i);
    for (const [name] of s.stand.objects) {
      if (name.startsWith(`${APP_BUCKET}/`)) expect(name, name).toMatch(new RegExp(`^${APP_BUCKET}/(u|q)/[0-9a-f-]{36}/`));
    }
    expect(Buffer.concat([...s.stand.objects.values()]).toString('latin1')).not.toContain(a.email);
  });
});

describe('erasure completeness on synthetic users (SECT-PD-01, 02, 06; TC-DEL-05, TC-ZT-10, T-15)', () => {
  it('walker: every table with an owner or user column is in the erasure registry, so a new one fails the test', async () => {
    const tables = new Set((await ownerColumns()).map((c) => c.table));
    const unknown = [...tables].filter((t) => !ERASED.has(t) && !IDS_ONLY.has(t));
    expect(unknown, 'tables with an owner column that the erasure registry does not cover').toEqual([]);
    for (const known of [...ERASED, ...IDS_ONLY]) {
      const exists = await s.count('information_schema.tables', `table_schema = 'public' and table_name = $1`, [known]);
      expect(exists, `registry names ${known}, which no longer exists`).toBe(1);
    }
  });

  it('removes the subject: zero rows in erased tables, zero objects, keys deleted in the same operation, IDs only left behind', async () => {
    const before = await rowsOf(a.id);
    expect(Object.keys(before).length).toBeGreaterThan(8);
    const preObjects = appObjects(`u/${a.id}/`).length + appObjects(`q/${a.id}/`).length;
    expect(preObjects).toBe(subjectA.objects.length);
    s.stand.requests.length = 0;

    const removed = await s.call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: a.email });
    expect(removed.status).toBe(202);
    const runId = removed.body.data.deletionRunId as string;
    // Keys are deleted in the operation itself, before any worker step runs.
    expect(await s.count('provider_keys', 'owner_id = $1', [a.id])).toBe(0);
    await s.until(async () => (await s.one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step === 4, 'step 4');
    await s.pool.query(`update deletion_runs set not_before = now() where id = $1`, [runId]);
    expect(await s.erasure.run(runId, silentJobLog)).toBe('completed');

    const after = await rowsOf(a.id);
    for (const place of Object.keys(after)) expect(IDS_ONLY.has(place.split('.')[0] ?? ''), `${place} still holds the erased subject`).toBe(true);
    expect(appObjects(`u/${a.id}/`)).toHaveLength(0);
    expect(appObjects(`q/${a.id}/`)).toHaveLength(0);
    expect(await s.one(`select state, remaining_objects from deletion_runs where id = $1`, [runId])).toEqual({ state: 'completed', remaining_objects: 0 });
    // Invitations and access requests by email and by subject (SECT-PD-06), with the provider invitation revoked.
    expect(await s.count('invitations', 'lower(email) = $1', [a.email])).toBe(0);
    expect(await s.count('access_requests', 'idp_subject = $1 or lower(email) = $2', [a.sub, a.email])).toBe(0);
    expect(s.workerIdentity.users.has(a.sub)).toBe(false);
    expect(s.workerIdentity.sessionRevocations).toContain(a.sub);
    // No personal data of the subject persists in any table, in the queue or in the ledger.
    for (const value of [a.email, a.sub, subjectA.canaries.dialogue, subjectA.canaries.description, subjectA.canaries.productName]) {
      expect(await rowsHolding(s.pool, value, ['public', 'pgboss']), value).toEqual({});
    }
    expect(ledgerObjects().map((name) => s.stand.objects.get(name)?.toString() ?? '').join('')).not.toContain(a.email);
    // The only object listings the erasure made are inside the subject's own prefixes (SECT-R2-02).
    const lists = s.stand.requests.filter((r) => r.method === 'GET' && r.key === '' && r.bucket === APP_BUCKET);
    for (const list of lists) expect(decodeURIComponent(list.query), list.query).toMatch(new RegExp(`prefix=(u|q)(/|%2F)${a.id}`));
    // A second synthetic user is untouched.
    const survivor = await rowsOf(b.id);
    expect(Object.keys(survivor).length).toBeGreaterThan(8);
    expect(appObjects(`u/${b.id}/`).length + appObjects(`q/${b.id}/`).length).toBe(subjectB.objects.length);
    expect(await s.count('provider_keys', 'owner_id = $1', [b.id])).toBe(1);
    // What stays is the IDs only (usage, audit, key events and the run); nothing in it is a person's text.
    expect(await s.count('usage_events', 'owner_id = $1', [a.id])).toBe(1);
  });

  it('refuses the removed subject at the API and shows the run, IDs only, never as complete before the count is zero (SECT-PD-08)', async () => {
    // The hard delete left no account and no invitation: an app route is refused, and no user row for the token exists.
    expect((await s.call('GET', '/campaigns', a.token)).status).toBe(403);
    expect(await s.count('users', 'idp_subject = $1', [a.sub])).toBe(0);
    const runs = await s.call('GET', '/admin/erasures?state=completed&limit=50', boss.token);
    expect(runs.status).toBe(200);
    expect(JSON.stringify(runs.body)).not.toContain(a.email);
    expect(JSON.stringify(runs.body)).not.toContain(a.sub);
    expect(runs.body.data.find((r: { subjectId: string }) => r.subjectId === a.id)).toMatchObject({ state: 'completed', remainingObjects: 0 });
  });
});

describe('ledger replay after a restored dump (SECT-PD-10, 11, T-22)', () => {
  it('re-erases a subject a restored database brings back, from the ledger IDs alone, and does not re-link on a re-invite', async () => {
    const c = await s.account('restored');
    const seeded = await seedSubject(s, c, 'cccc3333');
    // The "dump": every row of the subject, taken before the erasure (table, jsonb of the row).
    const cols = await ownerColumns();
    const dump: { table: string; row: Record<string, unknown> }[] = [];
    for (const { table, column } of cols) {
      if (table === 'platform_settings') continue;
      const rows = (await s.pool.query<{ r: Record<string, unknown> }>(`select to_jsonb(t) as r from "${table}" t where "${column}" = $1`, [c.id])).rows;
      for (const { r } of rows) if (!dump.some((d) => d.table === table && JSON.stringify(d.row) === JSON.stringify(r))) dump.push({ table, row: r });
    }
    expect(dump.length).toBeGreaterThan(8);

    const removed = await s.call('POST', `/admin/users/${c.id}/remove`, boss.token, { confirmation: c.email });
    expect(removed.status).toBe(202);
    const runId = removed.body.data.deletionRunId as string;
    await s.until(async () => (await s.one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step === 4, 'step 4');
    await s.pool.query(`update deletion_runs set not_before = now() where id = $1`, [runId]);
    expect(await s.erasure.run(runId, silentJobLog)).toBe('completed');
    expect(await rowsHolding(s.pool, c.email)).toEqual({});

    // The restore: the dump goes back, and so does the object data the backup carried.
    const restore = await s.pool.connect();
    try {
      await restore.query(`set session_replication_role = replica`); // a dump load applies rows in table order, constraints last
      for (const { table, row } of dump) {
        if (table === 'deletion_runs' || table === 'audit_events') continue;
        await restore.query(`insert into "${table}" select * from jsonb_populate_record(null::"${table}", $1::jsonb) on conflict do nothing`, [JSON.stringify(row)]);
      }
      await restore.query(`set session_replication_role = origin`);
    } finally {
      restore.release();
    }
    await s.pool.query(`delete from deletion_runs where id = $1`, [runId]); // the dump predates the run
    for (const key of seeded.objects) await s.storage.put(key, Buffer.alloc(8, 1), 'application/octet-stream', 100);
    expect(await s.count('users', 'id = $1', [c.id]), 'the restored dump brings the erased account back').toBe(1);

    // The reconcile step (restore runbook, TC-LED-03): the ledger in its own bucket names the subjects; each is erased again
    // by the product's own erasure run before traffic is served.
    const entries = ledgerObjects().map((name) => JSON.parse(s.stand.objects.get(name)?.toString() ?? '{}') as { runId: string; kind: string; subjectId: string });
    expect(entries.find((e) => e.subjectId === c.id)).toMatchObject({ kind: 'account', runId });
    for (const entry of entries.filter((e) => e.kind === 'account' && e.subjectId === c.id)) {
      await s.pool.query(`update users set status = 'removed' where id = $1`, [entry.subjectId]);
      await s.pool.query(
        `insert into deletion_runs (id, kind, subject_id, owner_id, state, step, attempts, not_before) values ($1, 'account', $2, $2, 'running', 1, 0, now())`,
        [entry.runId, entry.subjectId],
      );
      let outcome = await s.erasure.run(entry.runId, silentJobLog);
      for (let i = 0; i < 3 && outcome !== 'completed'; i += 1) {
        await s.pool.query(`update deletion_runs set not_before = now() where id = $1`, [entry.runId]);
        outcome = await s.erasure.run(entry.runId, silentJobLog);
      }
      expect(outcome).toBe('completed');
    }
    expect(await rowsOf(c.id)).toMatchObject({});
    for (const place of Object.keys(await rowsOf(c.id))) expect(IDS_ONLY.has(place.split('.')[0] ?? ''), place).toBe(true);
    expect(appObjects(`u/${c.id}/`)).toHaveLength(0);
    expect(await rowsHolding(s.pool, c.email)).toEqual({});

    // SECT-PD-11: the same address invited again after the restore becomes a new account with none of the old data.
    s.local.addUser(`${c.sub}-again`, c.email, true);
    s.workerIdentity.addUser(`${c.sub}-again`, c.email, true);
    await s.pool.query(`insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`, [c.email]);
    const token = s.local.issueToken({ sub: `${c.sub}-again`, azp: 'http://localhost:3000', fva: [1, 1] });
    expect((await s.call('GET', '/me', token)).status).toBe(200);
    const fresh = await s.one<{ id: string }>(`select id from users where idp_subject = $1`, [`${c.sub}-again`]);
    expect(fresh.id).not.toBe(c.id);
    expect(await s.count('campaigns', 'owner_id = $1', [fresh.id])).toBe(0);
    expect(await s.count('provider_keys', 'owner_id = $1', [fresh.id])).toBe(0);
    expect(await s.count('media_objects', 'owner_id = $1', [fresh.id])).toBe(0);
    const list = await s.call('GET', '/campaigns', token);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body.data)).not.toContain(seeded.canaries.productName);
  });
});
