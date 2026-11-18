import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Stops the baseline stack of the run and drops its database and roles. */
export default function teardown() {
  const state = process.env.PERF_STACK_STATE;
  if (!state) return;
  execFileSync(
    'node',
    [
      resolve(__dirname, '../../../../../tests/baselines/stack.mjs'),
      'down',
      '--state',
      resolve(state, '..'),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
}
