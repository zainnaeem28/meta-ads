import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedCodes, genericProbe, readsInput } from './support/cells.js';
import type { Probe } from './support/cells.js';
import { SPECIFIC, WAIVED } from './support/scenarios.js';
import { cellName, operations } from './support/spec.js';
import { bootWorld } from './support/world.js';
import type { World } from './support/world.js';

// TASK-065: the generated API matrix (every operation x every documented status), run against the running app.

let w: World;
beforeAll(async () => {
  w = await bootWorld('t65matrix');
  w.form = await bootWorld('t65form', { ACCESS_REQUEST_FORM_ENABLED: 'true' });
}, 300_000);
afterAll(async () => {
  await w?.form?.close();
  await w?.close();
});


for (const op of operations()) {
  describe(`${op.id} ${op.method} ${op.path}`, () => {
    for (const status of op.statuses) {
      const waiver = WAIVED[cellName(op, status)];
      const unread = status === 400 && !readsInput(op);
      const tag = waiver !== undefined ? ` [waived ${waiver.finding}]` : unread ? ' [waived CONF065-F4]' : '';
      it(`${cellName(op, status)}${tag}`, async () => {
        const probe = waiver?.probe ?? SPECIFIC[cellName(op, status)] ?? genericProbe(op, status);
        expect(probe, `no probe for ${cellName(op, status)}`).toBeDefined();
        const replies = [await (probe as Probe)(w, op)].flat();
        expect(replies.length).toBeGreaterThan(0);
        for (const seen of replies) {
          const expected = waiver?.instead ?? (unread ? 200 : status);
          expect(seen.status, `${cellName(op, status)} answered ${String(seen.status)} ${seen.text.slice(0, 200)}`).toBe(expected);
          if (status >= 400 && expected === status) {
            expect(seen.body.success).toBe(false);
            expect(allowedCodes(op, status), `code ${String(seen.code)}`).toContain(seen.code);
          }
        }
      });
    }
  });
}
