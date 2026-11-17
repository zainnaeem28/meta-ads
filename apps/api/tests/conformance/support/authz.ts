import { randomUUID } from 'node:crypto';
import * as fx from './fixtures.js';
import type { Account, World } from './world.js';
import type { Observed } from './cells.js';
import type { Params } from './spec.js';

// The records of one owner that the cross-user matrix (TC-AUT-09, TC-AUT-01) asks other callers for.

/** The path ids an operation of the owner's records takes, with the records created for the owner. */
export type Owned = (w: World, owner: Account) => Promise<Params>;

const campaign: Owned = async (w, owner) => ({ campaignId: (await fx.campaign(w, owner, { briefState: 'draft' })).id });
const draftOf: Owned = async (w, owner) => {
  const res = await w.call('POST', '/drafts', owner.token, { productName: 'Owner Draft' });
  return { draftId: res.body.data.id as string };
};
const mediaOf: Owned = async (w, owner) => ({ mediaId: await fx.media(w, owner) });
const videoOf: Owned = async (w, owner) => ({ videoJobId: await fx.videoJob(w, owner, await fx.campaign(w, owner)) });

export const OWNED: Readonly<Record<string, Owned>> = {
  'API-022': draftOf, 'API-023': draftOf, 'API-024': draftOf, 'API-025': draftOf,
  'API-031': mediaOf, 'API-032': mediaOf, 'API-035': mediaOf, 'API-036': mediaOf,
  'API-041': campaign, 'API-042': campaign, 'API-050': campaign, 'API-051': campaign, 'API-052': campaign, 'API-053': campaign,
  'API-060': campaign, 'API-061': campaign, 'API-070': campaign, 'API-075': campaign, 'API-076': campaign,
  'API-054': async (w, owner) => ({ issueId: await fx.claimIssue(w, owner, await fx.campaign(w, owner, { briefState: 'draft' })) }),
  'API-062': videoOf, 'API-063': videoOf, 'API-064': videoOf,
  'API-071': async (w, owner) => {
    const c = await fx.campaign(w, owner);
    return { assemblyId: await fx.assemblyJob(w, owner, c, await fx.videoJob(w, owner, c)) };
  },
};

/** What a reply shows a caller: everything but the request id and the instant. */
export const shapeOf = (seen: Observed): unknown => ({ status: seen.status, code: seen.code, message: seen.body.error?.message, details: seen.body.error?.details ?? null });

/** A stable text of the owner's rows in every table that holds their records (to prove another caller changed nothing). */
export async function snapshot(w: World, owner: Account): Promise<string> {
  // The worker runs beside the suite and moves the state of jobs the owner created earlier, so the job tables are compared
  // by row count (a foreign call that created or removed a job shows; only the api inserts them), the others by content.
  const content = ['campaigns', 'drafts', 'claim_issues', 'provider_keys'];
  const counted = ['brief_jobs', 'video_jobs', 'qc_runs', 'assembly_jobs', 'thumbstopper_jobs', 'idempotency_records'];
  const parts: string[] = [];
  for (const table of [...content, ...counted]) {
    const rows = await w.pool.query(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h, count(*)::int as n from ${table} t where owner_id = $1`, [owner.id]);
    parts.push(`${table}:${String(rows.rows[0].n)}:${content.includes(table) ? String(rows.rows[0].h) : ''}`);
  }
  const segments = await w.pool.query(`select md5(coalesce(string_agg(s::text, '|' order by s::text), '')) as h from brief_segments s where brief_id in (select id from briefs where owner_id = $1)`, [owner.id]);
  parts.push(`segments:${String(segments.rows[0].h)}`);
  return parts.join('\n');
}

export const random = (): string => randomUUID();
