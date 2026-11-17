import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { checkSegment, countWords, reconcileIssues } from '../domain/index.js';
import type { ClaimField, ExistingIssue, SegmentFinding } from '../domain/index.js';
import { BRIEF_REPOSITORY, BRIEF_RULES } from './brief-ports.js';
import type {
  BriefRecord,
  BriefRepository,
  BriefRules,
  ClaimOutcome,
  GenerationJobRecord,
  IssueRecord,
  NewIssue,
  SegmentRecord,
  SegmentWrite,
} from './brief-ports.js';

/** The most issues one response lists (the contract's `maxItems`). */
export const ISSUE_LIMIT = 200;
/** The segment column's check: at most 120 words. */
const MAX_WORDS = 120;

export interface BriefView {
  readonly brief: BriefRecord;
  readonly generationJob: GenerationJobRecord | null;
  readonly segments: readonly SegmentRecord[];
  readonly issues: readonly IssueRecord[];
}

export interface SegmentEdit {
  readonly position: number;
  readonly dialogue?: string;
  readonly prompt?: string;
}

const notFound = (): DomainError => new DomainError('not_found', 'Not found.');
const versionConflict = (): DomainError =>
  new DomainError('version_conflict', 'The brief was changed elsewhere. Reload it and try again.');

/**
 * The brief of a campaign (API-050 to API-052; REQ-007, REQ-008; SB-D11). Reads and writes are scoped to the owner, so
 * a foreign and a missing brief both answer 404. Writes lock the brief row, so two edits or an edit and an accept never
 * interleave. Segment text is edited in place and each changed segment's revision goes up, which is what marks the
 * clips built from it out of date (derived, never stored).
 */
@Injectable()
export class BriefService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(BRIEF_REPOSITORY) private readonly repository: BriefRepository,
    @Inject(BRIEF_RULES) private readonly rules: BriefRules,
  ) {}

  get(ownerId: string, campaignId: string): Promise<BriefView> {
    return this.database.uow.run(async (tx) => {
      const brief = await this.repository.findBrief(tx, ownerId, campaignId);
      if (brief === null) throw notFound();
      return this.view(tx, brief);
    });
  }

  /**
   * Saves segment edits under `If-Match`. Only a `draft` or `accepted` brief can be edited; an edit that changes text
   * sends an accepted brief back to `draft`, raises each changed segment's revision and re-runs the claim rules on
   * those segments alone: issues whose rule stopped firing close, new findings are raised.
   */
  async edit(ownerId: string, campaignId: string, expectedVersion: number, edits: readonly SegmentEdit[]): Promise<BriefView> {
    const rules = await this.rules.activeRules();
    return this.database.uow.run(async (tx) => {
      const brief = await this.repository.findBrief(tx, ownerId, campaignId, true);
      if (brief === null) throw notFound();
      if (brief.version !== expectedVersion) throw versionConflict();
      if (brief.state !== 'draft' && brief.state !== 'accepted') {
        throw new DomainError('state_conflict', `The brief is ${brief.state} and cannot be edited now.`);
      }
      const segments = await this.repository.segments(tx, brief.id);
      const writes = this.changes(segments, edits);
      if (writes.size === 0) return this.view(tx, brief);

      const active = segments.filter((segment) => segment.state === 'active');
      const lastPosition = Math.max(0, ...active.map((segment) => segment.position));
      const findings: SegmentFinding[] = [];
      for (const segment of segments) {
        const write = writes.get(segment.id);
        if (write === undefined) continue;
        await this.repository.updateSegment(tx, write);
        findings.push(
          ...checkSegment(rules, {
            dialogue: write.dialogue,
            prompt: write.prompt,
            isLast: segment.position === lastPosition,
          }).map((finding) => ({ ...finding, segmentId: segment.id })),
        );
      }
      const existing = await this.repository.liveIssues(tx, brief.id);
      const changed = new Set(writes.keys());
      const plan = reconcileIssues(existing.map(existingOf), findings, changed, changed);
      const raised: NewIssue[] = plan.raise.map((finding) => ({
        id: newId(),
        segmentId: finding.segmentId,
        field: finding.field,
        ruleId: finding.ruleId,
        class: finding.class,
        message: finding.message,
        spanStart: finding.spanStart,
        spanEnd: finding.spanEnd,
      }));
      await this.repository.closeIssues(tx, plan.close);
      await this.repository.insertIssues(tx, ownerId, brief.id, raised);
      const closedClass = new Map(existing.map((issue) => [issue.id, issue.class]));
      const events: { issueId: string; class: 'high_risk' | 'other'; outcome: ClaimOutcome }[] = [
        ...plan.close.map((issueId) => ({
          issueId,
          class: closedClass.get(issueId) ?? 'other',
          outcome: 'closed_by_edit' as const,
        })),
        ...raised.map((issue) => ({ issueId: issue.id, class: issue.class, outcome: 'raised' as const })),
      ];
      await this.repository.recordEvents(tx, ownerId, brief.id, events);
      return this.view(tx, await this.repository.saveBrief(tx, brief.id, 'draft'));
    });
  }

  /**
   * Accepts a `draft` brief with no open claim issue. An accepted brief at the version sent is returned as it is, so a
   * repeated call is harmless. Everything else is a conflict: a stale version is `version_conflict`, any other state
   * `state_conflict`; open issues are 422 `open_claim_issues`.
   */
  accept(ownerId: string, campaignId: string, expectedVersion: number): Promise<BriefView> {
    return this.database.uow.run(async (tx) => {
      const brief = await this.repository.findBrief(tx, ownerId, campaignId, true);
      if (brief === null) throw notFound();
      if (brief.version !== expectedVersion) throw versionConflict();
      if (brief.state === 'accepted') return this.view(tx, brief);
      if (brief.state !== 'draft') {
        throw new DomainError('state_conflict', `The brief is ${brief.state} and cannot be accepted now.`);
      }
      const open = await this.repository.openIssueCount(tx, brief.id);
      if (open > 0) {
        throw new DomainError(
          'open_claim_issues',
          'Resolve the open claim issues before accepting the brief.',
          [{ field: 'issues', code: 'open_claim_issues', message: `${String(open)} open claim issue(s) remain.` }],
        );
      }
      return this.view(tx, await this.repository.saveBrief(tx, brief.id, 'accepted'));
    });
  }

  private changes(segments: readonly SegmentRecord[], edits: readonly SegmentEdit[]): Map<string, SegmentWrite> {
    const writes = new Map<string, SegmentWrite>();
    const seen = new Set<number>();
    for (const edit of edits) {
      if (seen.has(edit.position)) throw invalid('segments', 'duplicate_position', 'Each position may appear once.');
      seen.add(edit.position);
      const segment = segments.find((candidate) => candidate.position === edit.position);
      if (segment === undefined) throw invalid('segments', 'unknown_position', `Segment ${String(edit.position)} does not exist.`);
      if (segment.state !== 'active') {
        throw new DomainError('state_conflict', `Segment ${String(edit.position)} is retired and cannot be edited.`);
      }
      const dialogue = edit.dialogue ?? segment.dialogue;
      const prompt = edit.prompt ?? segment.prompt;
      if (dialogue === segment.dialogue && prompt === segment.prompt) continue;
      const wordCount = countWords(dialogue);
      if (wordCount > MAX_WORDS) {
        throw invalid('dialogue', 'too_long', `The dialogue is limited to ${String(MAX_WORDS)} words.`);
      }
      writes.set(segment.id, { id: segment.id, dialogue, prompt, wordCount });
    }
    return writes;
  }

  private async view(tx: DbTx, brief: BriefRecord): Promise<BriefView> {
    const [segments, issues, generationJob] = await Promise.all([
      this.repository.segments(tx, brief.id),
      this.repository.issues(tx, brief.id, brief.acceptedAt, ISSUE_LIMIT),
      this.repository.latestGenerationJob(tx, brief.campaignId),
    ]);
    return { brief, generationJob, segments, issues };
  }
}

const existingOf = (issue: IssueRecord): ExistingIssue => ({
  id: issue.id,
  segmentId: issue.segmentId,
  field: issue.field as ClaimField,
  ruleId: issue.ruleId,
  resolution: issue.resolution,
});

function invalid(field: string, code: string, message: string): DomainError {
  return new DomainError('validation_failed', 'The request is not valid.', [{ field, code, message }]);
}
