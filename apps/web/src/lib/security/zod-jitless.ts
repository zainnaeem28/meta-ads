import { config } from 'zod';

/**
 * The policy refuses code generation from strings. Zod's compiled fast path probes for it with `Function("")`, which is
 * caught but still reported as a violation, so the schemas run in their interpreted mode.
 */
config({ jitless: true });
