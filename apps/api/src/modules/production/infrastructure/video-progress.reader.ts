import { and, eq, inArray, sql } from 'drizzle-orm';
import { briefJobs, briefSegments, briefs } from '../../../database/schema/brief.js';
import { campaigns } from '../../../database/schema/campaigns.js';
import { qcRuns, videoJobs } from '../../../database/schema/production.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { deriveProgress, isNonTerminal, labelOf } from '../domain/video-job.js';
import type { CampaignProgress } from '../domain/video-job.js';

type BriefState = 'generating' | 'draft' | 'accepted' | 'failed';

/** The shape campaigns' `CampaignProgressReader` port asks for; declared here so production imports nothing above itself. */
export interface ProgressSnapshotShape {
  readonly progress: CampaignProgress;
  readonly briefState: BriefState;
  readonly finalAvailable: boolean;
  readonly jobCounts: Readonly<Record<string, number>>;
  readonly latestAssemblyId: string | null;
  readonly thumbstopperJobId: string | null;
}

const CHUNK = 200;
const NON_TERMINAL = ['pending', 'submitting', 'submitted', 'processing'];

/**
 * Production's implementation of the campaigns' progress port (TD-D12): derived at read from the brief state, the
 * brief jobs, and the latest clip of each active segment. Assemblies and the thumbstopper add their own facts with their
 * tables; until then a campaign is never `completed` and offers no final video.
 */
export class VideoProgressReader {
  constructor(private readonly database: Pick<Database, 'uow'>) {}

  progressFor(
    ownerId: string,
    campaignIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProgressSnapshotShape>> {
    if (campaignIds.length === 0) return Promise.resolve(new Map());
    return this.database.uow.run((tx) => this.snapshots(tx, ownerId, campaignIds));
  }

  /** The owner's active campaigns in a derived progress; the owner's campaigns are read in chunks and derived. */
  async idsWithProgress(
    ownerId: string,
    progress: Exclude<CampaignProgress, 'in_progress'>,
  ): Promise<ReadonlySet<string>> {
    return this.database.uow.run(async (tx) => {
      const rows = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.ownerId, ownerId), eq(campaigns.state, 'active')));
      const ids = rows.map((row) => row.id);
      const matching = new Set<string>();
      for (let at = 0; at < ids.length; at += CHUNK) {
        const snapshots = await this.snapshots(tx, ownerId, ids.slice(at, at + CHUNK));
        for (const [id, snapshot] of snapshots)
          if (snapshot.progress === progress) matching.add(id);
      }
      return matching;
    });
  }

  private async snapshots(
    tx: DbTx,
    ownerId: string,
    ids: readonly string[],
  ): Promise<Map<string, ProgressSnapshotShape>> {
    const list = [...ids];
    const briefRows = await tx
      .select({ campaignId: briefs.campaignId, state: briefs.state })
      .from(briefs)
      .where(and(eq(briefs.ownerId, ownerId), inArray(briefs.campaignId, list)));
    const running = new Set<string>();
    const mark = (rows: readonly { campaignId: string | null }[]): void => {
      for (const row of rows) if (row.campaignId !== null) running.add(row.campaignId);
    };
    mark(
      await tx
        .selectDistinct({ campaignId: briefJobs.campaignId })
        .from(briefJobs)
        .where(
          and(
            eq(briefJobs.ownerId, ownerId),
            eq(briefJobs.kind, 'brief_generation'),
            inArray(briefJobs.campaignId, list),
            inArray(briefJobs.state, NON_TERMINAL),
          ),
        ),
    );
    mark(
      await tx
        .selectDistinct({ campaignId: videoJobs.campaignId })
        .from(videoJobs)
        .where(
          and(
            eq(videoJobs.ownerId, ownerId),
            inArray(videoJobs.campaignId, list),
            inArray(videoJobs.state, NON_TERMINAL),
          ),
        ),
    );
    mark(
      await tx
        .selectDistinct({ campaignId: videoJobs.campaignId })
        .from(qcRuns)
        .innerJoin(videoJobs, eq(videoJobs.id, qcRuns.videoJobId))
        .where(
          and(
            eq(qcRuns.ownerId, ownerId),
            inArray(videoJobs.campaignId, list),
            inArray(qcRuns.state, NON_TERMINAL),
          ),
        ),
    );
    const latest = await tx
      .selectDistinctOn([videoJobs.segmentId], {
        campaignId: videoJobs.campaignId,
        state: videoJobs.state,
      })
      .from(videoJobs)
      .innerJoin(briefSegments, eq(briefSegments.id, videoJobs.segmentId))
      .where(
        and(
          eq(videoJobs.ownerId, ownerId),
          inArray(videoJobs.campaignId, list),
          eq(briefSegments.state, 'active'),
        ),
      )
      .orderBy(videoJobs.segmentId, sql`${videoJobs.createdAt} desc`, sql`${videoJobs.id} desc`);
    const result = new Map<string, ProgressSnapshotShape>();
    for (const brief of briefRows) {
      const states = latest
        .filter((job) => job.campaignId === brief.campaignId)
        .map((job) => job.state);
      const jobCounts: Record<string, number> = {};
      for (const state of states) jobCounts[labelOf(state)] = (jobCounts[labelOf(state)] ?? 0) + 1;
      result.set(brief.campaignId, {
        progress: deriveProgress({
          anyNonTerminal: running.has(brief.campaignId) || states.some(isNonTerminal),
          briefFailed: brief.state === 'failed',
          latestVideoStates: states,
          assemblyDone: false,
          latestAssemblyFailed: false,
        }),
        briefState: brief.state as BriefState,
        finalAvailable: false,
        jobCounts,
        latestAssemblyId: null,
        thumbstopperJobId: null,
      });
    }
    return result;
  }
}
