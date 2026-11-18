import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The performance targets and budgets of the web app (TASK-119, NFR-02). Never written here: one source, the policy
// file the baselines and the budget script read (baselines.frontend), so a limit has one place to change.
const policyFile = process.env.CI_POLICY ?? resolve(__dirname, '../../config/quality-policy.json');

export interface RouteGroupBudget {
  jsKB: number;
  cssKB: number;
}

export interface PerfPolicy {
  lcpMs: number;
  inpMs: number;
  cls: number;
  tbtMs: number;
  samplesPerRoute: number;
  profiles: string[];
  routes: { id: string; path: string; session: string }[];
  bundleBudgets: {
    excludeRoutes: string[];
    groups: Record<string, RouteGroupBudget>;
  };
}

export const loadPerfPolicy = (file: string = policyFile): PerfPolicy =>
  (JSON.parse(readFileSync(file, 'utf8')) as { baselines: { frontend: PerfPolicy } }).baselines
    .frontend;

/** The ceilings of NFR-02 the budgets never loosen. */
export const VITALS_CEILING = { lcpMs: 2500, inpMs: 200, cls: 0.1 } as const;
