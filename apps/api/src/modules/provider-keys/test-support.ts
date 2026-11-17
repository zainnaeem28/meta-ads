// Test-only entry point: lets cross-module test suites reach internals without a deep import.
export { generateKek, kekEnv } from './infrastructure/test-support.js';
export type { Kek } from './infrastructure/test-support.js';
