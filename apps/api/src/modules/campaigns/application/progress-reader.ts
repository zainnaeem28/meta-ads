export type CampaignProgress = 'in_progress' | 'processing' | 'completed' | 'failed';
export type BriefState = 'generating' | 'draft' | 'accepted' | 'failed';

/** What the history shows of one campaign's jobs; derived at read, never stored (ARCHITECTURE §3.2, TD-D12). */
export interface ProgressSnapshot {
  readonly progress: CampaignProgress;
  readonly briefState: BriefState;
  readonly finalAvailable: boolean;
  /** Latest job per segment, counted by label. */
  readonly jobCounts: Readonly<Record<string, number>>;
  readonly latestAssemblyId: string | null;
  readonly thumbstopperJobId: string | null;
}

/** A campaign whose brief job has not produced anything yet: nothing is running or finished that the reader knows of. */
export const NO_JOBS: ProgressSnapshot = {
  progress: 'in_progress',
  briefState: 'generating',
  finalAvailable: false,
  jobCounts: {},
  latestAssemblyId: null,
  thumbstopperJobId: null,
};

/**
 * Read-only port owned by campaigns and implemented by production at bootstrap, so campaigns (L4) never imports
 * production (L6). A campaign the reader does not know has no jobs and reads as {@link NO_JOBS}.
 */
export interface CampaignProgressReader {
  progressFor(
    ownerId: string,
    campaignIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProgressSnapshot>>;
  /** The owner's campaigns in the given derived progress (the `filter` of API-040). */
  idsWithProgress(
    ownerId: string,
    progress: Exclude<CampaignProgress, 'in_progress'>,
  ): Promise<ReadonlySet<string>>;
}

export const CAMPAIGN_PROGRESS_READER = Symbol('CAMPAIGN_PROGRESS_READER');

/** Used until production supplies a reader: no job exists, so no campaign is processing, failed or completed. */
export const noJobsReader: CampaignProgressReader = {
  progressFor: () => Promise.resolve(new Map()),
  idsWithProgress: () => Promise.resolve(new Set()),
};
