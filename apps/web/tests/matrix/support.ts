import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GROUPS, type Group } from '../a11y/groups';

/** Where this ticket's screenshots and the recorded browser versions are committed. */
export const EVIDENCE = resolve(
  __dirname,
  process.env.EVIDENCE_DIR ?? '../../../../docs/evidence/TASK-117',
);

/** Where each project records the tests it ran, so the run fails when a project ran none (zero-test rule). */
export const RAN = resolve(__dirname, '../..', process.env.REPORT_DIR ?? 'reports/matrix', 'ran');

/** Projects whose browser cannot start on this machine, with the launch error (written by the global setup). */
export const UNAVAILABLE = `${RAN}-unavailable.json`;

export function unavailable(): Record<string, string> {
  return existsSync(UNAVAILABLE) ? JSON.parse(readFileSync(UNAVAILABLE, 'utf8')) : {};
}

/**
 * The smoke paths of TC-NFR-06, each on one real page of the built web app (the a11y suite's screen groups):
 * sign-in, FLOW-01 (new campaign wizard), FLOW-02 (brief review), FLOW-03 (clips) and FLOW-04 (assemble and download).
 */
export const JOURNEYS: { flow: string; group: Group }[] = [
  ['sign-in', 'auth-sign-in'],
  ['FLOW-01', 'wizard'],
  ['FLOW-02', 'brief'],
  ['FLOW-03', 'clips'],
  ['FLOW-04', 'final'],
].map(([flow, id]) => ({ flow, group: GROUPS.find((g) => g.id === id)! }));

/** Smallest touch target, in CSS px, on the phone profiles (TC-NFR-06). */
export const MIN_TOUCH = 44;

export const ensureDir = (dir: string) => mkdirSync(dir, { recursive: true });

export function recordRun(project: string, entry: Record<string, unknown>) {
  ensureDir(RAN);
  appendFileSync(`${RAN}/${project}.jsonl`, `${JSON.stringify(entry)}\n`);
}

export function recordVersion(project: string, info: Record<string, unknown>) {
  const dir = `${EVIDENCE}/versions`;
  ensureDir(dir);
  writeFileSync(`${dir}/${project}.json`, `${JSON.stringify(info, null, 2)}\n`);
}
