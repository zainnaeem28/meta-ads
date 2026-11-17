import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNED, shapeOf, snapshot } from './support/authz.js';
import { actorFor, send } from './support/cells.js';
import type { Observed } from './support/cells.js';
import { openDefect } from '../security/support/stack.js';
import * as fx from './support/fixtures.js';
import { isAdmin, isGuarded, operations } from './support/spec.js';
import type { Operation } from './support/spec.js';
import { bootWorld } from './support/world.js';
import type { Account, World } from './support/world.js';

// TC-AUT-09 (the authorization matrix), TC-AUT-01, 02, 03, 05, 06, 10, 12, TC-ZT-03: every operation of the file x
// {anon, owner, another user, an administrator that is not the owner, a suspended and a removed account}, against the running app.

let w: World;
let owner: Account;
let other: Account;
let boss: Account;
let suspended: Account;
let removed: Account;

beforeAll(async () => {
  w = await bootWorld('t65authz');
  owner = await w.account('owner');
  other = await w.account('other');
  boss = await w.admin('boss');
  suspended = await w.account('susp');
  removed = await w.account('gone');
  await w.pool.query(`update users set status = 'suspended' where id = $1`, [suspended.id]);
  await w.pool.query(`update users set status = 'removed' where id = $1`, [removed.id]);
  for (const who of [owner, other]) {
    await fx.putKey(w, who, 'openai');
    await fx.putKey(w, who, 'wavespeed');
  }
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const guarded = operations().filter(isGuarded);

describe('every operation: anonymous, suspended and removed callers (TC-AUT-06, TC-AUT-10)', () => {
  for (const op of guarded) {
    it(`${op.id} anon 401, suspended 403 account_suspended, removed 403 account_removed`, async () => {
      const anon = await send(w, op, undefined);
      expect([anon.status, anon.code]).toEqual([401, 'unauthenticated']);
      const s = await send(w, op, suspended.token);
      expect([s.status, s.code]).toEqual([403, 'account_suspended']);
      const r = await send(w, op, removed.token);
      expect([r.status, r.code]).toEqual([403, 'account_removed']);
    });
  }
  it('no operation is public except the health probes and the token-guarded metrics (zero operations without a guard)', () => {
    const open = operations()
      .filter((op) => !isGuarded(op))
      .map((op) => `${op.id} ${op.scopes.join('+')}`);
    expect(open).toEqual(['API-900 Pub', 'API-901 Pub', 'API-902 M', 'API-903 M']);
  });
});

describe('administrator operations by role (TC-AUT-09)', () => {
  for (const op of operations().filter(isAdmin)) {
    it(`${op.id}: a user is refused 403 forbidden_role and an administrator is let through`, async () => {
      for (const who of [owner, other]) {
        const refused = await send(w, op, who.token);
        expect([refused.status, refused.code], `${op.id} as a user`).toEqual([
          403,
          'forbidden_role',
        ]);
      }
      const admitted = await send(w, op, boss.token);
      expect(
        [401, 403],
        `${op.id} as an administrator answered ${String(admitted.status)} ${admitted.text.slice(0, 120)}`,
      ).not.toContain(admitted.status);
    });
  }
});

describe('records of another owner (TC-AUT-01, 02, 03, TC-ZT-03)', () => {
  const owned = operations().filter((op) => OWNED[op.id] !== undefined);
  it('the matrix covers every operation that takes a record id of the owner', () => {
    const takesId = operations().filter(
      (op) =>
        isGuarded(op) &&
        !isAdmin(op) &&
        op.pathParams.some((p) => p !== 'provider' && p !== 'position'),
    );
    expect(takesId.map((op) => op.id).sort()).toEqual(owned.map((op) => op.id).sort());
  });
  for (const op of owned) {
    it(`${op.id}: another user and an administrator get the answer of an id that never existed, and nothing changes`, async () => {
      const params = await (OWNED[op.id] as NonNullable<(typeof OWNED)[string]>)(w, owner);
      const before = await snapshot(w, owner);
      const phantom = await send(w, op, other.token, {
        params: Object.fromEntries(Object.keys(params).map((k) => [k, crypto.randomUUID()])),
      });
      expect([phantom.status, phantom.code]).toEqual([404, 'not_found']);
      const attempts: Observed[] = [];
      for (const who of [other, boss]) attempts.push(await send(w, op, who.token, { params }));
      for (const seen of attempts) {
        expect(shapeOf(seen), `${op.id} must not tell a foreign id from a missing one`).toEqual(
          shapeOf(phantom),
        );
        expect(
          Object.keys(seen.headers).filter((h) =>
            ['allow', 'location', 'etag', 'retry-after'].includes(h),
          ),
        ).toEqual([]);
      }
      const after = await snapshot(w, owner);
      expect(
        after.split('\n').filter((line, i) => line !== before.split('\n')[i]),
        `${op.id} changed the owner's rows`,
      ).toEqual([]);
      // The id is real: its owner is not told it is missing (the 404 above is the ownership check, not an empty table).
      const mine = await send(w, op, owner.token, { params });
      expect(
        [401, 403, 404],
        `${op.id} as the owner answered ${String(mine.status)}`,
      ).not.toContain(mine.status);
    });
  }

  it('a foreign campaign list and search show no record of the owner and no hint of one (TC-AUT-04)', async () => {
    const c = await fx.campaign(w, owner);
    await w.pool.query(`update campaigns set product_name = 'zq-needle-7731 Cap' where id = $1`, [
      c.id,
    ]);
    const mine = await w.call('GET', '/campaigns?q=zq-needle-7731', owner.token);
    expect(mine.body.data.map((row: { id: string }) => row.id)).toContain(c.id);
    for (const who of [other, boss]) {
      const theirs = await w.call('GET', '/campaigns?q=zq-needle-7731', who.token);
      expect(theirs.status).toBe(200);
      expect(theirs.body.data).toEqual([]);
      expect(theirs.body.metaData.pagination.returnedCount).toBe(0);
      expect(JSON.stringify(theirs.body)).not.toContain(c.id);
    }
    const drafts = await w.call('GET', '/drafts', other.token);
    expect(JSON.stringify(drafts.body)).not.toContain(owner.id);
  });

  it('a campaign being deleted and a never-created id look the same to the owner (TC-AUT-03)', async () => {
    const c = await fx.campaign(w, owner);
    await w.pool.query(`update campaigns set state = 'deleting' where id = $1`, [c.id]);
    const gone = await w.call('GET', `/campaigns/${c.id}`, owner.token);
    const never = await w.call('GET', `/campaigns/${crypto.randomUUID()}`, owner.token);
    expect(
      shapeOf({
        status: gone.status,
        code: gone.body.error?.code,
        body: gone.body,
      } as unknown as Observed),
    ).toEqual(
      shapeOf({
        status: never.status,
        code: never.body.error?.code,
        body: never.body,
      } as unknown as Observed),
    );
    expect(gone.status).toBe(404);
  });

  it('a foreign media id gives no signed URL and a foreign object path is no route (TC-AUT-05)', async () => {
    const media = await fx.media(w, owner);
    const url = await w.call('GET', `/media/${media}/url`, other.token);
    expect([url.status, url.body.error?.code]).toEqual([404, 'not_found']);
    expect(url.raw).not.toMatch(/https?:\/\//);
    const anon = await w.call('GET', `/media/${media}/url`);
    expect(anon.status).toBe(401);
    const path = await w.raw('GET', `/api/v1/u/${owner.id}/media/${media}`, {
      authorization: `Bearer ${other.token}`,
    });
    expect(path.status).toBe(404);
  });

  it('cross-owner attempts on API-042 are audited as access.denied_foreign, one event per attempt (TC-AUT-01)', async () => {
    const c = await fx.campaign(w, owner);
    const before = await w.count(
      'audit_events',
      `action = 'access.denied_foreign' and actor_id = $1`,
      [other.id],
    );
    for (let i = 0; i < 2; i += 1)
      expect((await w.call('DELETE', `/campaigns/${c.id}`, other.token)).status).toBe(404);
    expect(
      await w.count('audit_events', `action = 'access.denied_foreign' and actor_id = $1`, [
        other.id,
      ]),
    ).toBe(before + 2);
  });

  openDefect(
    'CONF065-F5',
    'every cross-owner attempt on a record is audited, one event per attempt (TC-AUT-01), not only API-042',
    async () => {
      const params = await (OWNED['API-041'] as NonNullable<(typeof OWNED)[string]>)(w, owner);
      const before = await w.count('audit_events', `actor_id = $1 and outcome = 'denied'`, [
        other.id,
      ]);
      expect((await w.call('GET', `/campaigns/${params['campaignId']}`, other.token)).status).toBe(
        404,
      );
      expect(
        await w.count('audit_events', `actor_id = $1 and outcome = 'denied'`, [other.id]),
      ).toBe(before + 1);
    },
  );
});

describe('what each role may reach (the role boundary table of SECURITY-DESIGN §16.2, for the DAST baseline)', () => {
  it('writes the matrix of operation x role the baseline scan authenticates with, from the running app', async () => {
    const roles: [string, Account | undefined][] = [
      ['anonymous', undefined],
      ['user', owner],
      ['admin', boss],
      ['suspended', suspended],
      ['removed', removed],
    ];
    const table: Record<string, Record<string, number>> = {};
    for (const op of guarded) {
      table[op.id] = {};
      for (const [name, who] of roles) {
        const params =
          OWNED[op.id] === undefined
            ? {}
            : await (OWNED[op.id] as NonNullable<(typeof OWNED)[string]>)(w, owner);
        const seen = await send(w, op, who?.token, { params: name === 'user' ? params : {} });
        (table[op.id] as Record<string, number>)[name] = seen.status;
      }
    }
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('reports/conformance', { recursive: true });
    writeFileSync('reports/conformance/role-matrix.json', `${JSON.stringify(table, null, 2)}\n`);
    for (const op of guarded) {
      const row = table[op.id] as Record<string, number>;
      expect(row['anonymous']).toBe(401);
      expect(row['suspended']).toBe(403);
      expect(row['removed']).toBe(403);
      if (isAdmin(op)) expect(row['user']).toBe(403);
    }
  });
});

export type { Operation };
void actorFor;
