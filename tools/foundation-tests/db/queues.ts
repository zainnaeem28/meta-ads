import type { Queue } from 'pg-boss';

// Foundation stand-in for apps/api/src/platform/jobs/queues.ts (name, policy and options).
// `probe-standard` shares the common job table; `probe-partitioned` gets its own table, which is
// the case `pg_dump` must still be able to read.
export const baseQueues: Queue[] = [
  { name: 'probe-standard', policy: 'standard', retryLimit: 0, expireInSeconds: 900 },
  {
    name: 'probe-partitioned',
    policy: 'standard',
    retryLimit: 0,
    expireInSeconds: 900,
    partition: true,
  },
];
