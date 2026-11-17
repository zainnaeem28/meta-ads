export { BriefModule, briefJobHandlers } from './brief.module.js';
export type { BriefApiEdge, BriefWorkerEdge } from './brief.module.js';
export { ClaimCountsService } from './application/claim-counts.service.js';
export type { ClaimCheckCounts } from './application/claim-counts.service.js';
export type { ClaimWindow } from './application/brief-ports.js';
// The claim engine and the rule reader, for the one other module that checks free text with them: production's thumbstopper call-out (API-075).
export { BrandRulesReader } from './infrastructure/repositories/brand-rules.reader.js';
export { checkSegment, compileRules } from './domain/claim-check.js';
export type { CompiledRules, Finding } from './domain/claim-check.js';
export type { BrandRule } from './domain/brand-rules.js';
export { dropSensitiveSentences } from './application/worker/post-process.js';
export { brandRulesSeedStep } from './infrastructure/repositories/brand-rules-file.js';
