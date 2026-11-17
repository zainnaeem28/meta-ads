import { describe, expect, it } from 'vitest';
import { localSubject, readLocalSession, signLocalSession } from './local-session';

const NOW = 1_800_000_000;
const session = { sub: 'user_local_x', email: 'a@b.co', exp: NOW + 60 };

describe('local session cookie', () => {
  it('round-trips an active session', async () => {
    const token = await signLocalSession(session);
    expect(await readLocalSession(token, NOW)).toEqual({ status: 'active', session });
  });
  it('reports no cookie as none', async () => {
    expect(await readLocalSession(undefined, NOW)).toEqual({ status: 'none' });
    expect(await readLocalSession('', NOW)).toEqual({ status: 'none' });
  });
  it('reports a timed-out session as expired', async () => {
    const token = await signLocalSession({ ...session, exp: NOW - 1 });
    expect(await readLocalSession(token, NOW)).toEqual({ status: 'expired' });
  });
  it('treats a forged, tampered or malformed cookie as expired', async () => {
    const [payload, signature] = (await signLocalSession(session)).split('.');
    const forged = Buffer.from(JSON.stringify({ ...session, exp: NOW + 9999 })).toString(
      'base64url',
    );
    for (const bad of [
      `${forged}.${signature}`,
      `${payload}.AAAA`,
      'garbage',
      `${payload}.${signature}.x`,
      'a.b',
    ]) {
      expect(await readLocalSession(bad, NOW)).toEqual({ status: 'expired' });
    }
    const wrongShape = Buffer.from('{"sub":1}').toString('base64url');
    const sig = (await signLocalSession(session)).split('.')[1]!;
    expect(await readLocalSession(`${wrongShape}.${sig}`, NOW)).toEqual({ status: 'expired' });
  });
  it('derives a stable subject that is not the email', async () => {
    const sub = await localSubject(' Ada@Example.com ');
    expect(sub).toBe(await localSubject('ada@example.com'));
    expect(sub).not.toContain('ada');
    expect(sub).not.toBe(await localSubject('bob@example.com'));
  });
});
