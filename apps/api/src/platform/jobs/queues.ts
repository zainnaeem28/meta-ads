import type { Queue } from 'pg-boss';

/**
 * The queue catalogue (ARCHITECTURE §2 and §5, ADR-003, SB-D24): every queue the api or the worker uses, in code.
 * `jobs:migrate` creates or updates each one under `app_migrator`; the runtime processes never create a queue, and
 * start-up refuses to run when one is missing. Adding a queue is a change here, released through that step.
 *
 * Submit queues carry `retryLimit: 0`: a paid provider call is attempted at most once (REQ-009, ADR-003); the
 * outcome of a lost attempt is settled by the recovery sweep, never by a retry.
 */
export interface CatalogueQueue extends Queue {
  readonly name: string;
  readonly policy: 'standard';
  readonly retryLimit: number;
  readonly expireInSeconds: number;
  /** Where the design names the queue: the document section, or the flow it belongs to. */
  readonly source: string;
}

const HOUR = 3600;

/** A queue whose handler may call a paid provider: one attempt only. */
function submit(name: string, source: string, expireInSeconds = 300): CatalogueQueue {
  return { name, policy: 'standard', retryLimit: 0, expireInSeconds, source };
}

/** A free step retried with exponential backoff, at most an hour between attempts. */
function retried(
  name: string,
  source: string,
  retryLimit: number,
  expireInSeconds = 900,
): CatalogueQueue {
  return {
    name,
    policy: 'standard',
    retryLimit,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: HOUR,
    expireInSeconds,
    source,
  };
}

/** A cron-fired job: the next tick is the retry. */
function cron(name: string, source: string): CatalogueQueue {
  return { name, policy: 'standard', retryLimit: 0, expireInSeconds: 300, source };
}

export const QUEUES: readonly CatalogueQueue[] = [
  // Paid provider submits (at most once)
  submit('brief.generate', '§5.3 brief generation job'),
  submit('brief.analyze-image', '§5.4 image analysis'),
  submit('production.video-submit', '§5.5 F-PJ claim and submit'),
  submit('production.thumbstopper-submit', '§5.5 F-PJ claim and submit'),
  submit('production.qc-run', '§5.6 QC run (transcription)'),
  // Provider polling: a poll is free and re-scheduled by the sweep when lost
  retried('production.poll', '§5.5 F-PJ poll', 5, 120),
  // Free steps with their own retry rules
  retried('video.copy-output', '§5.5 output copy (retryLimit 20)', 20, 900),
  retried('media.sanitize', '§5.4 sanitize (up to 3 retries)', 3, 300),
  retried('production.assembly-render', '§5.7 assembly', 3, 1800),
  retried('lifecycle.campaign-deletion', '§5.8 deletion run (retryLimit 10)', 10, 1800),
  retried('lifecycle.account-erasure', '§5.8 erasure run (retryLimit 10)', 10, 1800),
  retried('identity.revoke-sessions', '§5.11 on demand (5 retries)', 5, 300),
  // Scheduled by the worker (§5.11 F-SWEEP)
  cron('platform.recovery-sweep', '§5.11 every minute'),
  cron('platform.cleanup', '§5.11 hourly'),
  cron('media.unattached-sweep', '§5.11 hourly'),
  cron('identity.expire-invitations', '§5.11 hourly'),
  cron('production.provider-copy-cleanup', '§5.11 hourly'),
];

export type QueueName = (typeof QUEUES)[number]['name'];

const byName = new Map(QUEUES.map((queue) => [queue.name, queue]));

export function queueNamed(name: string): CatalogueQueue | undefined {
  return byName.get(name);
}

export const QUEUE_NAMES: readonly string[] = QUEUES.map((queue) => queue.name);

/** The options `createQueue` and `updateQueue` receive: the pg-boss queue definition without our bookkeeping. */
export function queueOptions(queue: CatalogueQueue): Omit<Queue, 'name'> {
  const options: Record<string, unknown> = { ...queue };
  delete options['name'];
  delete options['source'];
  return options as Omit<Queue, 'name'>;
}
