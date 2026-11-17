import type { DbTx } from '../../../platform/db/index.js';
import type { ClaimField, CompiledRules, Resolution, RuleClass } from '../domain/index.js';

export interface BriefRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly state: 'generating' | 'draft' | 'accepted' | 'failed';
  readonly version: number;
  readonly acceptedAt: string | null;
  readonly updatedAt: string;
}

export interface SegmentRecord {
  readonly id: string;
  readonly position: number;
  readonly state: 'active' | 'retired';
  readonly revision: number;
  readonly dialogue: string;
  readonly prompt: string;
  readonly wordCount: number;
}

export interface IssueRecord {
  readonly id: string;
  readonly briefId: string;
  readonly segmentId: string;
  readonly segmentPosition: number;
  readonly field: ClaimField;
  readonly ruleId: string;
  readonly class: RuleClass;
  readonly resolution: Resolution;
  readonly message: string;
  readonly spanStart: number | null;
  readonly spanEnd: number | null;
  readonly clearReason: string | null;
}

export interface GenerationJobRecord {
  readonly id: string;
  readonly state: string;
  readonly causeClass: string | null;
  readonly causeMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string;
}

export interface NewIssue {
  readonly id: string;
  readonly segmentId: string;
  readonly field: ClaimField;
  readonly ruleId: string;
  readonly class: RuleClass;
  readonly message: string;
  readonly spanStart: number | null;
  readonly spanEnd: number | null;
}

export interface SegmentWrite {
  readonly id: string;
  readonly dialogue: string;
  readonly prompt: string;
  readonly wordCount: number;
}

export type ClaimOutcome = 'raised' | 'closed_by_edit' | 'cleared_with_reason';

/** Module-private persistence of the brief tables; every method runs in the caller's transaction and is owner-scoped. */
export interface BriefRepository {
  /** The owner's brief of a campaign; `lock` takes the row `FOR UPDATE`. A foreign and a missing campaign both give null. */
  findBrief(tx: DbTx, ownerId: string, campaignId: string, lock?: boolean): Promise<BriefRecord | null>;
  segments(tx: DbTx, briefId: string): Promise<SegmentRecord[]>;
  /** Open issues first, then the ones resolved since the last accept (all of them when never accepted); at most `limit`. */
  issues(tx: DbTx, briefId: string, acceptedAt: string | null, limit: number): Promise<IssueRecord[]>;
  /** Every issue of the brief that is still open or cleared (what an edit reconciles against). */
  liveIssues(tx: DbTx, briefId: string): Promise<IssueRecord[]>;
  openIssueCount(tx: DbTx, briefId: string): Promise<number>;
  latestGenerationJob(tx: DbTx, campaignId: string): Promise<GenerationJobRecord | null>;
  /** Writes the text, goes the segment revision up by one. */
  updateSegment(tx: DbTx, write: SegmentWrite): Promise<void>;
  /** Version up by one, new state, `accepted_at` set when accepted and cleared otherwise. */
  saveBrief(tx: DbTx, briefId: string, state: 'draft' | 'accepted'): Promise<BriefRecord>;
  insertIssues(tx: DbTx, ownerId: string, briefId: string, issues: readonly NewIssue[]): Promise<void>;
  closeIssues(tx: DbTx, ids: readonly string[]): Promise<void>;
  recordEvents(
    tx: DbTx,
    ownerId: string,
    briefId: string,
    events: readonly { issueId: string; class: RuleClass; outcome: ClaimOutcome }[],
  ): Promise<void>;
  findIssue(tx: DbTx, ownerId: string, issueId: string, lock?: boolean): Promise<IssueRecord | null>;
  clearIssue(tx: DbTx, issueId: string, userId: string, reason: string): Promise<IssueRecord>;
}

export const BRIEF_REPOSITORY = Symbol('BRIEF_REPOSITORY');

/** The compiled brand rules claim checks run with (an adapter reads them from `brand_rules`). */
export interface BriefRules {
  activeRules(): Promise<CompiledRules>;
}

export const BRIEF_RULES = Symbol('BRIEF_RULES');
