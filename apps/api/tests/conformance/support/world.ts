import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootStack } from '../../security/support/stack.js';
import type { Account, Body, Stack } from '../../security/support/stack.js';
import { REAL_MIGRATIONS } from '../../../src/platform/db/test-database.js';

// The running app of this suite: the security suite's stack (the real API and worker composition roots on real PostgreSQL,
// an in-process object store and provider stand-ins) plus the migrations of the production slice that stack predates, and the
// configuration the matrix needs (metrics token, access-request form).

export const METRICS_TOKEN = 'm'.repeat(48);
/** The models the api prices a reservation with: the stubs the committed price table names. */
const MODELS = {
  OPENAI_TEXT_MODEL: 'local-stub-text',
  OPENAI_VISION_MODEL: 'local-stub-vision',
  OPENAI_IMAGE_MODEL: 'local-stub-image',
  RATE_LIMIT_IP_KEY: 'r'.repeat(40),
};
const LATER_MIGRATIONS = [
  '0100_task-055-production-assembly.sql',
  '0110_task-057-production-thumbstopper.sql',
];

export interface World extends Stack {
  /** A second app with the access-request form enabled (API-002 answers 404 while the form is off). */
  form?: World;
  /** A request as `fastify.inject` sees it, at any path (root or `/api/v1`), with any headers. */
  raw(
    method: string,
    url: string,
    headers?: Record<string, string>,
    payload?: unknown,
  ): Promise<{ status: number; headers: Record<string, unknown>; text: string; body: Body }>;
}

const sqlStatements = (file: string): string[] =>
  (readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '')
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');

export async function bootWorld(label: string, env: Record<string, string> = {}): Promise<World> {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries({ METRICS_TOKEN, ...MODELS, ...env })) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  const stack = await bootStack(label);
  for (const file of LATER_MIGRATIONS)
    for (const statement of sqlStatements(file)) await stack.pool.query(statement);
  const close = stack.close.bind(stack);
  return Object.assign(stack, {
    async raw(
      method: string,
      url: string,
      headers: Record<string, string> = {},
      payload?: unknown,
    ) {
      const res = await stack.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: method as 'GET',
          url,
          headers,
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
      let body = { success: res.statusCode < 400, metaData: {} } as Body;
      try {
        body = JSON.parse(res.body) as Body;
      } catch {
        /* a non-JSON body (csv, metrics, 408) carries no envelope */
      }
      return {
        status: res.statusCode,
        headers: res.headers as Record<string, unknown>,
        text: res.body,
        body,
      };
    },
    async close() {
      await close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  });
}

export type { Account };
