import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { traceFile, writeLcov } from './trace.ts';

export function setup(): void {
  mkdirSync(dirname(traceFile), { recursive: true });
  rmSync(traceFile, { force: true });
}

export function teardown(): void {
  writeLcov();
}
