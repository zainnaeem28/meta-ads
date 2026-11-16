import type { ClaimField, RuleClass } from './brand-rules.js';
import type { Finding } from './claim-check.js';

/** Which issues an edit closes and which it raises (REQ-008): the pure part of re-running the checks. */

export type Resolution = 'open' | 'closed_by_edit' | 'cleared_with_reason';

export interface ExistingIssue {
  readonly id: string;
  readonly segmentId: string;
  readonly field: ClaimField;
  readonly ruleId: string;
  readonly resolution: Resolution;
}

export interface SegmentFinding extends Finding {
  readonly segmentId: string;
}

export interface Reconciliation {
  /** Open issues whose rule no longer fires on the edited text: they close `closed_by_edit`. */
  readonly close: readonly string[];
  /** Findings with no issue yet: they are raised. */
  readonly raise: readonly SegmentFinding[];
}

const keyOf = (item: { segmentId: string; field: ClaimField; ruleId: string }): string =>
  `${item.segmentId}\u0000${item.field}\u0000${item.ruleId}`;

/**
 * Compares the findings of a re-run with the issues on the brief. An open issue stays while its rule still fires, and a
 * cleared one stays cleared while it fires on text that was not changed; when its segment was edited, a still-firing
 * rule is raised again because the reason was given for other text. Closed issues never reopen: a new finding is a new issue.
 * Only the segments in `checked` take part: the others were not re-run.
 */
export function reconcileIssues(
  existing: readonly ExistingIssue[],
  findings: readonly SegmentFinding[],
  checked: ReadonlySet<string>,
  changed: ReadonlySet<string>,
): Reconciliation {
  const firing = new Set(findings.map(keyOf));
  const close = existing
    .filter((issue) => issue.resolution === 'open' && checked.has(issue.segmentId) && !firing.has(keyOf(issue)))
    .map((issue) => issue.id);
  const holding = new Set(
    existing
      .filter(
        (issue) =>
          issue.resolution === 'open' || (issue.resolution === 'cleared_with_reason' && !changed.has(issue.segmentId)),
      )
      .map(keyOf),
  );
  return { close, raise: findings.filter((finding) => !holding.has(keyOf(finding))) };
}

/** A high-risk issue cannot be cleared by a reason (REQ-008); only an edit that stops the rule firing closes it. */
export function canClear(issueClass: RuleClass): boolean {
  return issueClass === 'other';
}
