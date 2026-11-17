import { describe, expect, it } from 'vitest';
import type { DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { compileRules } from '../domain/index.js';
import type {
  BriefRecord,
  BriefRepository,
  ClaimOutcome,
  GenerationJobRecord,
  IssueRecord,
  NewIssue,
  SegmentRecord,
  SegmentWrite,
} from './brief-ports.js';
import { BriefService } from './brief.service.js';
import { IssuesService } from './issues.service.js';

const OWNER = '0197a1b2-0000-7000-8000-000000000001';
const CAMPAIGN = '0197a1b2-0000-7000-8000-0000000000c1';
const words = (n: number): string => `${Array.from({ length: n }, () => 'tea').join(' ')}.`;
const CLEAN = words(33);
const LAST = `${words(28)} Adults 21+ only. Take the free 2-minute quiz`;

const rules = compileRules([
  {
    id: 'hr_cure',
    class: 'high_risk',
    clearable: false,
    kind: 'phrase',
    params: { phrases: ['cures'] },
    message: 'No cure claims.',
    rulesVersion: 1,
    active: true,
  },
  {
    id: 'other_min',
    class: 'other',
    clearable: true,
    kind: 'word_count_min',
    params: { min: 32 },
    message: 'Too short.',
    rulesVersion: 1,
    active: true,
  },
] as never);

/** An in-memory brief repository that keeps the same rules as the SQL one (owner scoping, in-place revisions). */
class Memory implements BriefRepository {
  brief: BriefRecord = {
    id: 'b1',
    campaignId: CAMPAIGN,
    state: 'draft',
    version: 1,
    acceptedAt: null,
    updatedAt: 't',
  };
  owner = OWNER;
  segs: SegmentRecord[] = [
    {
      id: 's1',
      position: 1,
      state: 'active',
      revision: 1,
      dialogue: CLEAN,
      prompt: 'p',
      wordCount: 33,
    },
    {
      id: 's2',
      position: 2,
      state: 'active',
      revision: 1,
      dialogue: LAST,
      prompt: 'p',
      wordCount: 36,
    },
  ];
  rows: (IssueRecord & { owner: string })[] = [];
  events: { issueId: string; outcome: ClaimOutcome }[] = [];
  job: GenerationJobRecord | null = null;

  findBrief(_tx: DbTx, ownerId: string, campaignId: string) {
    return Promise.resolve(ownerId === this.owner && campaignId === CAMPAIGN ? this.brief : null);
  }
  segments() {
    return Promise.resolve(this.segs.map((s) => ({ ...s })));
  }
  issues(_tx: DbTx, _b: string, _a: string | null, limit: number) {
    return Promise.resolve(this.rows.slice(0, limit));
  }
  liveIssues() {
    return Promise.resolve(this.rows.filter((r) => r.resolution !== 'closed_by_edit'));
  }
  openIssueCount() {
    return Promise.resolve(this.rows.filter((r) => r.resolution === 'open').length);
  }
  latestGenerationJob() {
    return Promise.resolve(this.job);
  }
  updateSegment(_tx: DbTx, w: SegmentWrite) {
    this.segs = this.segs.map((s) =>
      s.id === w.id
        ? {
            ...s,
            dialogue: w.dialogue,
            prompt: w.prompt,
            wordCount: w.wordCount,
            revision: s.revision + 1,
          }
        : s,
    );
    return Promise.resolve();
  }
  saveBrief(_tx: DbTx, _id: string, state: 'draft' | 'accepted') {
    this.brief = {
      ...this.brief,
      state,
      version: this.brief.version + 1,
      acceptedAt: state === 'accepted' ? 'now' : null,
    };
    return Promise.resolve(this.brief);
  }
  insertIssues(_tx: DbTx, ownerId: string, briefId: string, issues: readonly NewIssue[]) {
    for (const issue of issues) {
      const position = this.segs.find((s) => s.id === issue.segmentId)?.position ?? 0;
      this.rows.push({
        ...issue,
        briefId,
        segmentPosition: position,
        resolution: 'open',
        clearReason: null,
        owner: ownerId,
      });
    }
    return Promise.resolve();
  }
  closeIssues(_tx: DbTx, ids: readonly string[]) {
    this.rows = this.rows.map((r) =>
      ids.includes(r.id) ? { ...r, resolution: 'closed_by_edit' } : r,
    );
    return Promise.resolve();
  }
  recordEvents(
    _tx: DbTx,
    _o: string,
    _b: string,
    events: readonly { issueId: string; class: 'high_risk' | 'other'; outcome: ClaimOutcome }[],
  ) {
    this.events.push(...events);
    return Promise.resolve();
  }
  findIssue(_tx: DbTx, ownerId: string, issueId: string) {
    return Promise.resolve(this.rows.find((r) => r.id === issueId && r.owner === ownerId) ?? null);
  }
  clearIssue(_tx: DbTx, issueId: string, _u: string, reason: string) {
    this.rows = this.rows.map((r) =>
      r.id === issueId ? { ...r, resolution: 'cleared_with_reason', clearReason: reason } : r,
    );
    return Promise.resolve(this.rows.find((r) => r.id === issueId)!);
  }
}

function setup() {
  const repo = new Memory();
  const database = { uow: { run: <T>(fn: (tx: DbTx) => Promise<T>) => fn({} as DbTx) } };
  const brief = new BriefService(database as never, repo, {
    activeRules: () => Promise.resolve(rules),
  });
  const issues = new IssuesService(database as never, repo);
  return { repo, brief, issues };
}

const code = async (promise: Promise<unknown>): Promise<string> => {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
};

describe('BriefService', () => {
  it('reads the brief with segments, issues and the generation job, owner-scoped', async () => {
    const { brief, repo } = setup();
    repo.job = {
      id: 'j',
      state: 'completed',
      causeClass: null,
      causeMessage: null,
      createdAt: 'a',
      updatedAt: 'b',
      deadlineAt: 'c',
    };
    const view = await brief.get(OWNER, CAMPAIGN);
    expect(view.segments).toHaveLength(2);
    expect(view.generationJob?.id).toBe('j');
    expect(await code(brief.get('someone-else', CAMPAIGN))).toBe('not_found');
  });

  it('refuses a stale version and a brief that is generating or failed', async () => {
    const { brief, repo } = setup();
    expect(await code(brief.edit(OWNER, CAMPAIGN, 9, [{ position: 1, dialogue: 'x' }]))).toBe(
      'version_conflict',
    );
    expect(await code(brief.accept(OWNER, CAMPAIGN, 9))).toBe('version_conflict');
    expect(await code(brief.edit('other', CAMPAIGN, 1, [{ position: 1, dialogue: 'x' }]))).toBe(
      'not_found',
    );
    for (const state of ['generating', 'failed'] as const) {
      repo.brief = { ...repo.brief, state };
      expect(await code(brief.edit(OWNER, CAMPAIGN, 1, [{ position: 1, dialogue: 'x' }]))).toBe(
        'state_conflict',
      );
      expect(await code(brief.accept(OWNER, CAMPAIGN, 1))).toBe('state_conflict');
    }
  });

  it('raises findings on the edited segment only, bumps its revision and the version, and records events', async () => {
    const { brief, repo } = setup();
    const view = await brief.edit(OWNER, CAMPAIGN, 1, [{ position: 1, dialogue: 'It cures it.' }]);
    expect(view.brief).toMatchObject({ state: 'draft', version: 2 });
    expect(view.segments.map((s) => s.revision)).toEqual([2, 1]);
    expect(view.issues.map((i) => i.ruleId).sort()).toEqual(['hr_cure', 'other_min']);
    expect(repo.events.map((e) => e.outcome)).toEqual(['raised', 'raised']);
    // the same rules still fire: nothing new is raised; fixing the text closes both
    await brief.edit(OWNER, CAMPAIGN, 2, [{ position: 1, prompt: 'new' }]);
    expect(repo.rows.filter((r) => r.resolution === 'open')).toHaveLength(2);
    const fixed = await brief.edit(OWNER, CAMPAIGN, 3, [{ position: 1, dialogue: CLEAN }]);
    expect(fixed.issues.every((i) => i.resolution === 'closed_by_edit')).toBe(true);
    expect(repo.events.filter((e) => e.outcome === 'closed_by_edit')).toHaveLength(2);
  });

  it('writes nothing when no text changes, and returns an accepted brief to draft when it does', async () => {
    const { brief, repo } = setup();
    const same = await brief.edit(OWNER, CAMPAIGN, 1, [{ position: 1, dialogue: CLEAN }]);
    expect(same.brief.version).toBe(1);
    repo.brief = { ...repo.brief, state: 'accepted', acceptedAt: 'now' };
    const changed = await brief.edit(OWNER, CAMPAIGN, 1, [{ position: 2, prompt: 'other prompt' }]);
    expect(changed.brief).toMatchObject({ state: 'draft', acceptedAt: null, version: 2 });
  });

  it('rejects unknown, duplicate and retired positions and too many words', async () => {
    const { brief, repo } = setup();
    expect(await code(brief.edit(OWNER, CAMPAIGN, 1, [{ position: 4, dialogue: 'x' }]))).toBe(
      'validation_failed',
    );
    expect(
      await code(
        brief.edit(OWNER, CAMPAIGN, 1, [
          { position: 1, dialogue: 'x' },
          { position: 1, prompt: 'y' },
        ]),
      ),
    ).toBe('validation_failed');
    expect(
      await code(
        brief.edit(OWNER, CAMPAIGN, 1, [
          { position: 1, dialogue: Array.from({ length: 121 }, () => 'a').join(' ') },
        ]),
      ),
    ).toBe('validation_failed');
    repo.segs[1] = { ...repo.segs[1]!, state: 'retired' };
    expect(await code(brief.edit(OWNER, CAMPAIGN, 1, [{ position: 2, dialogue: 'x' }]))).toBe(
      'state_conflict',
    );
  });

  it('accepts a draft with no open issue, is idempotent when accepted, and is blocked by an open issue', async () => {
    const { brief, repo } = setup();
    await brief.edit(OWNER, CAMPAIGN, 1, [{ position: 1, dialogue: 'It cures it.' }]);
    expect(await code(brief.accept(OWNER, CAMPAIGN, 2))).toBe('open_claim_issues');
    await brief.edit(OWNER, CAMPAIGN, 2, [{ position: 1, dialogue: CLEAN }]);
    const accepted = await brief.accept(OWNER, CAMPAIGN, 3);
    expect(accepted.brief).toMatchObject({ state: 'accepted', version: 4 });
    expect((await brief.accept(OWNER, CAMPAIGN, 4)).brief.version).toBe(4);
    expect(repo.brief.state).toBe('accepted');
  });
});

describe('IssuesService', () => {
  async function withIssues() {
    const ctx = setup();
    await ctx.brief.edit(OWNER, CAMPAIGN, 1, [{ position: 1, dialogue: 'It cures it.' }]);
    const high = ctx.repo.rows.find((r) => r.class === 'high_risk')!;
    const other = ctx.repo.rows.find((r) => r.class === 'other')!;
    return { ...ctx, high, other };
  }

  it('never clears a high-risk issue, whatever the reason', async () => {
    const { issues, high, repo } = await withIssues();
    expect(await code(issues.clear(OWNER, high.id, 'because'))).toBe('claim_not_clearable');
    expect(repo.rows.find((r) => r.id === high.id)?.resolution).toBe('open');
  });

  it('clears an other issue with its reason, once; unknown and foreign issues are 404; closed ones 409', async () => {
    const { issues, other, repo } = await withIssues();
    expect(await code(issues.clear('someone-else', other.id, 'reason'))).toBe('not_found');
    const done = await issues.clear(OWNER, other.id, 'reason');
    expect(done).toMatchObject({ resolution: 'cleared_with_reason', clearReason: 'reason' });
    expect(repo.events.filter((e) => e.outcome === 'cleared_with_reason')).toHaveLength(1);
    expect((await issues.clear(OWNER, other.id, 'other reason')).clearReason).toBe('reason');
    expect(repo.events.filter((e) => e.outcome === 'cleared_with_reason')).toHaveLength(1);
    repo.rows = repo.rows.map((r) =>
      r.id === other.id ? { ...r, resolution: 'closed_by_edit' } : r,
    );
    expect(await code(issues.clear(OWNER, other.id, 'again'))).toBe('state_conflict');
  });
});
