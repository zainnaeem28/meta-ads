import { describe, expect, it } from 'vitest';
import type { ExistingIssue, SegmentFinding } from './issues.js';
import { canClear, reconcileIssues } from './issues.js';

const finding = (segmentId: string, ruleId: string, field: 'dialogue' | 'prompt' = 'dialogue'): SegmentFinding => ({
  segmentId,
  ruleId,
  field,
  class: 'other',
  message: 'm',
  spanStart: null,
  spanEnd: null,
});
const issue = (id: string, segmentId: string, ruleId: string, resolution: ExistingIssue['resolution']): ExistingIssue => ({
  id,
  segmentId,
  field: 'dialogue',
  ruleId,
  resolution,
});

describe('reconcileIssues (TC-REV-02)', () => {
  it('closes an open issue whose rule no longer fires on a checked segment', () => {
    const result = reconcileIssues([issue('i1', 's1', 'r1', 'open')], [], new Set(['s1']), new Set(['s1']));
    expect(result).toEqual({ close: ['i1'], raise: [] });
  });

  it('keeps an open issue while its rule fires, and raises only new findings', () => {
    const result = reconcileIssues(
      [issue('i1', 's1', 'r1', 'open')],
      [finding('s1', 'r1'), finding('s1', 'r2'), finding('s1', 'r1', 'prompt')],
      new Set(['s1']),
      new Set(['s1']),
    );
    expect(result.close).toEqual([]);
    expect(result.raise.map((f) => `${f.ruleId}/${f.field}`)).toEqual(['r2/dialogue', 'r1/prompt']);
  });

  it('leaves the issues of segments that were not re-run alone', () => {
    const result = reconcileIssues([issue('i1', 's2', 'r1', 'open')], [], new Set(['s1']), new Set());
    expect(result.close).toEqual([]);
  });

  it('a cleared issue holds on unchanged text and is raised again when its segment was edited', () => {
    const cleared = [issue('i1', 's1', 'r1', 'cleared_with_reason')];
    expect(reconcileIssues(cleared, [finding('s1', 'r1')], new Set(['s1']), new Set()).raise).toEqual([]);
    expect(reconcileIssues(cleared, [finding('s1', 'r1')], new Set(['s1']), new Set(['s1'])).raise).toHaveLength(1);
  });

  it('a closed issue never reopens: a new finding is a new issue', () => {
    const result = reconcileIssues([issue('i1', 's1', 'r1', 'closed_by_edit')], [finding('s1', 'r1')], new Set(['s1']), new Set(['s1']));
    expect(result.raise).toHaveLength(1);
  });
});

describe('canClear (TC-REV-01, TC-REV-03)', () => {
  it('only the other class can be cleared by a reason', () => {
    expect(canClear('other')).toBe(true);
    expect(canClear('high_risk')).toBe(false);
  });
});
