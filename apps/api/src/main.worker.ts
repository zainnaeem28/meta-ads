import 'reflect-metadata';
import { createWorkerApp } from './bootstrap/worker.module.js';
import { loadConfigOrExit } from './platform/config/index.js';
import { buildLogger, secretValuesOf } from './platform/logging/index.js';

async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit('worker');
  const { logger } = buildLogger({
    level: config.LOG_LEVEL,
    ...(config.RELEASE_SHA === undefined ? {} : { releaseSha: config.RELEASE_SHA }),
    secretValues: secretValuesOf(config),
  });
  const { context, runtime } = await createWorkerApp(config, { logger });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    runtime
      .drain()
      .then(() => context.close())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(
          `worker drain failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `worker failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
