import { describe, expect, it } from 'vitest';
import { MeController } from './me.controller.js';

describe('MeController', () => {
  it('delegates API-001 to the service with the guard-published session', async () => {
    const seen: unknown[] = [];
    const controller = new MeController({ me: async (auth: unknown) => (seen.push(auth), { linkState: 'not_linked' }) } as never);
    const auth = { linked: false as const, session: { subject: 's' } };
    expect(await controller.get(auth)).toEqual({ linkState: 'not_linked' });
    expect(seen).toEqual([auth]);
  });
});
