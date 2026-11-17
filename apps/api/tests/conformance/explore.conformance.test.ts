import { afterAll, beforeAll, describe, it } from 'vitest';
import { bootWorld } from './support/world.js';
import type { World } from './support/world.js';
let w: World;
beforeAll(async () => { w = await bootWorld('t65x'); }, 300_000);
afterAll(async () => { await w?.close(); });
describe('x', () => {
  it('explore', async () => {
    const u = await w.account('u'); const a = await w.admin('ad');
    const js = { 'content-type': 'application/json' };
    for (const [m, url, t, h, p] of [
      ['POST', '/api/v1/drafts', u, js, '{"broken'],
      ['POST', '/api/v1/drafts', u, js, '{"productName":"x"}'],
      ['POST', '/api/v1/admin/invitations', a, js, '{"broken'],
      ['PUT', '/api/v1/admin/settings/signup-mode', a, js, '{"broken'],
      ['PUT', '/api/v1/admin/settings/signup-mode', a, js, '{"mode":"nope"}'],
    ] as any[]) { const r = await w.raw(m, url, { authorization: `Bearer ${t.token}`, ...h }, p); console.log('TRY', m, url, r.status, r.text.slice(0,200)); }
  }, 60_000);
});
