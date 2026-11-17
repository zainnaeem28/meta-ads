import 'reflect-metadata';
import { createApiApp } from './bootstrap/api.module.js';
import { loadConfigOrExit } from './platform/config/index.js';
import { createHttpLogging, secretValuesOf } from './platform/logging/index.js';

async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit('api');
  const logging = createHttpLogging({
    level: config.LOG_LEVEL,
    ...(config.RELEASE_SHA === undefined ? {} : { releaseSha: config.RELEASE_SHA }),
    secretValues: secretValuesOf(config),
  });
  const { app } = await createApiApp(config, logging);
  await app.listen(config.API_PORT ?? 4000, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `api failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
