import { stdTimeFunctions, pino } from 'pino';
import type { DestinationStream, Logger } from 'pino';
import { filterFields } from './allow-list.js';
import { REDACTED, REDACTION_PATHS, createScrubber } from './redact.js';
import type { Scrubber } from './redact.js';
import { correlationOf } from './request-id.js';
import type { JobPayloadBase } from './request-id.js';

function passthrough(): Scrubber {
  const scrub = ((value: string) => value) as Scrubber;
  scrub.learn = () => undefined;
  return scrub;
}

export interface LoggerOptions {
  readonly level?: string;
  readonly releaseSha?: string;
  /** Literal secret values (from configuration) to remove wherever they appear. */
  readonly secretValues?: readonly string[];
  readonly destination?: DestinationStream;
  /** Only the negative probe turns redaction off; production code never sets this. */
  readonly redaction?: boolean;
}

export interface BuiltLogger {
  readonly logger: Logger;
  readonly scrub: Scrubber;
}

/** pino JSON to stdout: allow-listed fields, scrubbed values, redaction paths, releaseSha on every line. */
export function buildLogger(options: LoggerOptions = {}): BuiltLogger {
  const redaction = options.redaction ?? true;
  const scrub: Scrubber = redaction ? createScrubber(options.secretValues) : passthrough();
  const releaseSha = options.releaseSha ?? 'unknown';
  const sanitize = (fields: object): Record<string, unknown> =>
    redaction ? filterFields(fields as Record<string, unknown>, scrub) : { ...fields };
  const logger = pino(
    {
      level: options.level ?? 'info',
      base: { releaseSha },
      timestamp: stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => sanitize(bindings),
        log: (fields) => {
          // The message travels in its own argument; a `msg` field would duplicate the key.
          const kept = sanitize(fields);
          delete kept['msg'];
          return kept;
        },
      },
      hooks: {
        logMethod(args, method) {
          // Message strings (and printf arguments) are scrubbed before pino formats them.
          const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrub(arg) : arg));
          const [first, ...rest] = scrubbed as unknown[];
          if (first instanceof Error) {
            // pino would copy err.message (and the stack) into the line unscrubbed.
            const code = (first as { code?: unknown }).code;
            const fields = typeof code === 'string' ? { code } : {};
            const text = typeof rest[0] === 'string' ? rest.shift() : scrub(first.message);
            return method.apply(this, [fields, text, ...rest] as unknown as Parameters<
              typeof method
            >);
          }
          if (
            first !== null &&
            typeof first === 'object' &&
            typeof (first as { msg?: unknown }).msg === 'string'
          ) {
            const obj = first as { msg: string };
            return method.apply(this, [
              { ...obj, msg: scrub(obj.msg) },
              ...rest,
            ] as unknown as Parameters<typeof method>);
          }
          return method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
      ...(redaction ? { redact: { paths: [...REDACTION_PATHS], censor: REDACTED } } : {}),
    },
    options.destination ?? pino.destination({ fd: 1, sync: true }),
  );
  if (redaction) {
    // pino resets the bindings formatter for children, so child bindings are filtered here.
    const child = logger.child.bind(logger);
    logger.child = ((bindings: object, childOptions?: object) =>
      child(sanitize(bindings), childOptions)) as Logger['child'];
  }
  return { logger, scrub };
}

export interface JobEnvelope {
  readonly id: string;
  readonly name: string;
  readonly data?: JobPayloadBase | null;
}

/** Child logger for one job: jobId, jobType and the correlationId carried in the payload. */
export function jobLogger(logger: Logger, job: JobEnvelope): Logger {
  return logger.child({
    jobId: job.id,
    jobType: job.name,
    correlationId: correlationOf(job.data),
  });
}

/** Worker path: run a handler under a job logger; a failure logs a code only and is rethrown. */
export async function runLoggedJob<T>(
  logger: Logger,
  job: JobEnvelope,
  handler: (log: Logger) => Promise<T>,
): Promise<T> {
  const log = jobLogger(logger, job);
  const started = Date.now();
  try {
    const result = await handler(log);
    log.info({ outcome: 'ok', durationMs: Date.now() - started }, 'job finished');
    return result;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    log.error(
      {
        outcome: 'error',
        durationMs: Date.now() - started,
        ...(typeof code === 'string' ? { code } : {}),
      },
      error instanceof Error ? error.message : 'job failed',
    );
    throw error;
  }
}
