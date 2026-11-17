import { describe, expect, it } from 'vitest';
import {
  apiQuery,
  buildUrl,
  campaignHref,
  campaignStatus,
  draftHref,
  draftMatches,
  draftName,
  draftSegments,
  draftStepLabel,
  parseUrl,
  updatedLabel,
} from './model';

describe('SCREEN-005 URL state', () => {
  it('parses tab, search, status and page, and ignores anything unknown', () => {
    expect(parseUrl('?tab=drafts&q=reishi&status=failed&page=3')).toEqual({ tab: 'drafts', q: 'reishi', status: 'failed', page: 3 });
    expect(parseUrl('?tab=x&status=bogus&page=0')).toEqual({ tab: 'history', q: '', status: '', page: 1 });
    expect(parseUrl('')).toEqual({ tab: 'history', q: '', status: '', page: 1 });
  });

  it('omits defaults and keeps the status only on the history tab', () => {
    expect(buildUrl({ tab: 'history', q: '', status: '', page: 1 })).toBe('');
    expect(buildUrl({ tab: 'history', q: 'a b', status: 'failed', page: 2 })).toBe('?q=a+b&status=failed&page=2');
    expect(buildUrl({ tab: 'drafts', q: '', status: 'failed', page: 1 })).toBe('?tab=drafts');
  });

  it('sends a search only from two characters', () => {
    expect(apiQuery('a')).toBeUndefined();
    expect(apiQuery('  ab ')).toBe('ab');
    expect(apiQuery('x'.repeat(120))).toHaveLength(100);
  });
});

describe('SCREEN-005 rows', () => {
  const NOW = Date.parse('2026-11-16T12:00:00.000Z');
  it('words the time since an update', () => {
    expect(updatedLabel('2026-11-16T11:59:30.000Z', NOW)).toBe('Updated just now');
    expect(updatedLabel('2026-11-16T11:48:00.000Z', NOW)).toBe('Updated 12 min ago');
    expect(updatedLabel('2026-11-16T10:00:00.000Z', NOW)).toBe('Updated 2 h ago');
    expect(updatedLabel('2026-11-15T09:00:00.000Z', NOW, 'Saved')).toBe('Saved yesterday');
    expect(updatedLabel('2026-11-13T09:00:00.000Z', NOW)).toBe('Updated 3 days ago');
    expect(updatedLabel('2026-10-01T09:00:00.000Z', NOW)).toBe('Updated 1 Oct 2026');
  });

  it('maps a campaign to a badge and to the stage it opens', () => {
    const c = { id: 'c1', progress: 'processing', briefState: 'accepted', finalAvailable: false } as const;
    expect(campaignStatus(c)).toEqual({ label: 'Clips generating', variant: 'info' });
    expect(campaignHref(c)).toBe('/campaigns/c1/clips');
    const done = { ...c, progress: 'completed', finalAvailable: true } as const;
    expect(campaignStatus(done).label).toBe('Final ready');
    expect(campaignHref(done)).toBe('/campaigns/c1/final');
    expect(campaignStatus({ ...done, finalAvailable: false }).label).toBe('Clips ready');
    expect(campaignStatus({ ...c, briefState: 'draft' }).label).toBe('Brief ready to review');
    expect(campaignStatus({ ...c, briefState: 'generating' }).label).toBe('Brief generating');
    expect(campaignHref({ ...c, briefState: 'draft' })).toBe('/campaigns/c1/brief');
    expect(campaignStatus({ ...c, progress: 'failed' })).toEqual({ label: 'Needs attention', variant: 'destructive' });
  });

  it('presents a draft: name, step, segments and the search match', () => {
    expect(draftName({ productName: null })).toBe('Untitled draft');
    expect(draftName({ productName: ' Chai ' })).toBe('Chai');
    expect(draftHref({ id: 'd1' })).toBe('/campaigns/new?draft=d1');
    expect(draftStepLabel(3)).toBe('Step 3 of 4: Audience and direction');
    expect(draftStepLabel(5)).toBe('Step 4 of 4: Concept and script');
    expect(draftSegments({ durationSeconds: 45 })).toBe(3);
    expect(draftSegments({ durationSeconds: null })).toBe(0);
    expect(draftMatches({ productName: 'Reishi', productDescription: null }, 'REI')).toBe(true);
    expect(draftMatches({ productName: null, productDescription: 'night tincture' }, 'tinct')).toBe(true);
    expect(draftMatches({ productName: 'Chai', productDescription: null }, 'reishi')).toBe(false);
    expect(draftMatches({ productName: 'Chai', productDescription: null }, ' ')).toBe(true);
  });
});
