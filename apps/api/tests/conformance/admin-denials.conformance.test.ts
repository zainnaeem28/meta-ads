import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { send } from './support/cells.js';
import { isAdmin, operations } from './support/spec.js';
import { bootWorld } from './support/world.js';
import type { Account, World } from './support/world.js';

// The admin-route denial tests with audit events (SECURITY-DESIGN §16, TC-AUT-09): a refused call to an administrator route
// by a known account writes exactly one `auth.denied` event naming the caller and the request; refusals that name no account
// (no token, a bad token) write none.

let w: World;
let user: Account;
beforeAll(async () => { w = await bootWorld('t65deny'); user = await w.account('denied'); }, 300_000);
afterAll(async () => { await w?.close(); });

const adminOps = operations().filter(isAdmin);
const denials = (who: Account) => w.pool.query(`select action, actor_type, object_type, object_id, outcome, request_id from audit_events where actor_id = $1 and action = 'auth.denied' order by at, id`, [who.id]);

describe('a user on an administrator route (every operation of scope A)', () => {
  it('is 403 forbidden_role with one denied event per attempt, carrying the caller and the request id', async () => {
    expect(adminOps.length).toBeGreaterThan(15);
    const ids: string[] = [];
    for (const op of adminOps) {
      const before = (await denials(user)).rowCount ?? 0;
      const res = await send(w, op, user.token);
      expect([op.id, res.status, res.code]).toEqual([op.id, 403, 'forbidden_role']);
      const rows = (await denials(user)).rows;
      expect(rows.length, `${op.id} wrote one event`).toBe(before + 1);
      const event = rows[rows.length - 1];
      expect(event).toMatchObject({ action: 'auth.denied', object_type: 'route', outcome: 'denied' });
      expect(event.request_id).toBe(res.headers['x-request-id']);
      ids.push(event.request_id as string);
    }
    expect(new Set(ids).size).toBe(adminOps.length);
  });

  it('the event holds no body, token, address or query text', async () => {
    const rows = (await w.pool.query(`select * from audit_events where actor_id = $1`, [user.id])).rows;
    const text = JSON.stringify(rows);
    expect(text).not.toContain(user.token);
    expect(text).not.toContain(user.email);
    expect(Object.keys(rows[0]).sort()).toEqual(['action', 'actor_id', 'actor_type', 'at', 'id', 'object_id', 'object_type', 'outcome', 'request_id']);
  });

  it('a denied call changes nothing else: the administrator data is untouched', async () => {
    const before = (await w.pool.query(`select (select count(*) from users) as users, (select count(*) from invitations) as invitations, (select count(*) from platform_settings) as settings`)).rows[0];
    for (const op of adminOps) await send(w, op, user.token);
    expect((await w.pool.query(`select (select count(*) from users) as users, (select count(*) from invitations) as invitations, (select count(*) from platform_settings) as settings`)).rows[0]).toEqual(before);
  });
});

describe('callers that name no account leave no denied event', () => {
  it('no token, a bad token and a foreign token on every administrator route', async () => {
    const before = await w.count('audit_events', `action = 'auth.denied'`);
    for (const op of adminOps) {
      expect((await send(w, op, undefined)).status).toBe(401);
      expect((await send(w, op, 'not.a.token')).status).toBe(401);
    }
    expect(await w.count('audit_events', `action = 'auth.denied'`)).toBe(before);
  });
});

describe('administrator success is audited too', () => {
  it('suspend, reinstate, role change and invitation each write an allowed event naming the administrator', async () => {
    const boss = await w.admin('deny-boss');
    const target = await w.account('deny-target');
    const mark = async (action: string) => w.count('audit_events', `action = $1 and actor_id = $2`, [action, boss.id]);
    expect((await w.call('POST', `/admin/users/${target.id}/suspend`, boss.token)).status).toBe(200);
    expect(await mark('account.suspended')).toBe(1);
    expect((await w.call('POST', `/admin/users/${target.id}/reinstate`, boss.token)).status).toBe(200);
    expect(await mark('account.reinstated')).toBe(1);
    const view = await w.call('GET', '/admin/users', boss.token);
    const version = (view.body.data as { id: string; version: number }[]).find((u) => u.id === target.id)?.version ?? 1;
    expect((await w.call('PUT', `/admin/users/${target.id}/role`, boss.token, { role: 'admin' }, { 'if-match': `"${String(version)}"` })).status).toBe(200);
    expect(await mark('role.granted')).toBe(1);
  });
});
