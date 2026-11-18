import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import type pg from 'pg';
import { LOCAL_SESSION_COOKIE } from '../../../src/lib/auth/local-session';

// The baseline stack of this run (tests/baselines/stack.mjs): synthetic accounts with a signed local-session cookie and an
// api bearer each, five campaigns per account ("Baseline product <n>-<k>"), each with an accepted brief and one stub job.
export interface Account {
  sub: string;
  email: string;
  token: string;
  cookie: string;
}
interface State {
  webUrl: string;
  apiUrl: string;
  database: string;
  dbAdminUrl: string;
  users: Account[];
  admin: Account;
}
export const stack = (): State =>
  JSON.parse(readFileSync(process.env.PERF_STACK_STATE!, 'utf8')) as State;

/** Sessions of two different people, and the product name prefix of the records each one owns. */
export const accountA = (): Account => stack().users[0]!;
export const accountB = (): Account => stack().users[1]!;
export const PRODUCT_A = 'Baseline product 1-';
export const PRODUCT_B = 'Baseline product 2-';

export async function signIn(context: BrowserContext, account: Account): Promise<void> {
  await context.clearCookies();
  await context.addCookies([
    { name: LOCAL_SESSION_COOKIE, value: account.cookie, url: stack().webUrl },
  ]);
}

/** Ids of the campaigns an account owns, newest first, read from the api with that account's own bearer. */
export async function campaignIds(account: Account): Promise<string[]> {
  const res = await fetch(`${stack().apiUrl}/api/v1/campaigns?limit=10`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((c) => c.id);
}

/** The api's current ETag of a resource, read with that account's own bearer. */
export async function etagOf(account: Account, path: string): Promise<string | null> {
  const res = await fetch(`${stack().apiUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  return res.headers.get('etag');
}

/** Runs SQL on the run's throwaway database (the test fixture only: backdating a record, putting a brief back to draft). */
export async function sql(text: string, values: unknown[] = []): Promise<void> {
  await withDatabase((query) => query(text, values));
}

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** More campaigns (each with its draft, accepted brief and one segment) for an account, so a list has the counts a test needs. */
export async function seedCampaigns(account: Account, count: number, name: string): Promise<void> {
  await withDatabase(async (query) => {
    const owner = (await query('select id from users where idp_subject = $1', [account.sub]))
      .rows[0]!.id as string;
    for (let n = 1; n <= count; n += 1) {
      await query(
        `with c as (
           insert into campaigns (id, owner_id, state, product_name, product_description, segment_count)
           values (gen_random_uuid(), $1, 'active', $2, 'Synthetic campaign for layout checks.', 1) returning id),
         d as (
           insert into drafts (id, owner_id, step, product_name, product_description, segment_count, campaign_id)
           select gen_random_uuid(), $1, 5, $2, 'Synthetic campaign for layout checks.', 1, id from c),
         b as (
           insert into briefs (id, campaign_id, owner_id, state, accepted_at)
           select gen_random_uuid(), id, $1, 'accepted', now() from c returning id)
         insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count)
         select gen_random_uuid(), id, 1, 'Synthetic dialogue.', 'Synthetic prompt.', 2 from b`,
        [owner, `${name} ${n}`],
      );
    }
  });
}

async function withDatabase<T>(work: (query: Query) => Promise<T>): Promise<T> {
  const s = stack();
  const require = createRequire(resolve(__dirname, '../../../../api/package.json'));
  const { Client } = require('pg') as typeof pg;
  const url = new URL(s.dbAdminUrl);
  url.pathname = `/${s.database}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await work((text, values) => client.query(text, values));
  } finally {
    await client.end();
  }
}
