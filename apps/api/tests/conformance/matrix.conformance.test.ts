import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedCodes, genericProbe } from './support/cells.js';
import type { Probe } from './support/cells.js';
import { cellName, operations } from './support/spec.js';
import { bootWorld } from './support/world.js';
import type { World } from './support/world.js';

// TASK-065: the generated API matrix (every operation x every documented status), run against the running app.

let w: World;
beforeAll(async () => { w = await bootWorld('t65matrix'); }, 300_000);
afterAll(async () => { await w?.close(); });

const specific: Record<string, Probe> = {};

for (const op of operations()) {
  describe(`${op.id} ${op.method} ${op.path}`, () => {
    for (const status of op.statuses) {
      it(`${cellName(op, status)}`, async () => {
        const probe = specific[cellName(op, status)] ?? genericProbe(op, status);
        expect(probe, `no probe for ${cellName(op, status)}`).toBeDefined();
        const seen = await (probe as Probe)(w, op);
        expect(seen.status, `${cellName(op, status)} answered ${String(seen.status)} ${seen.text.slice(0, 200)}`).toBe(status);
        if (status >= 400) {
          expect(seen.body.success).toBe(false);
          expect(allowedCodes(op, status), `code ${String(seen.code)}`).toContain(seen.code);
        }
      });
    }
  });
}
