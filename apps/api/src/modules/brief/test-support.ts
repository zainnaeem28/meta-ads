// Test-only entry point: lets cross-module test suites reach internals without a deep import.
export { brandRulesSeedStep } from './infrastructure/repositories/brand-rules-file.js';
export { dropSensitiveSentences } from './application/worker/post-process.js';
