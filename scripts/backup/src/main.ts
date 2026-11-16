import { writeFileSync } from 'node:fs';
import { ConfigError, EXIT_CONFIG, EXIT_MIGRATION_WINDOW, loadConfig } from './config.ts';
import { runBackup } from './run.ts';
import { jsonLogger } from './util.ts';

// Entry point of the `backup` image (`node src/main.ts`). Exit codes: 0 run complete, 1 run failed, 75 a release
// migration kept the run from starting, 78 the environment was refused.
const log = jsonLogger();
let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(EXIT_CONFIG);
  }
  throw error;
}
const result = await runBackup(config, log);
log[result.ok ? 'info' : 'error']('backup_run', { ...result });
const resultFile = process.env['BACKUP_RESULT_FILE'];
if (resultFile !== undefined && resultFile !== '')
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
process.exit(
  result.ok ? 0 : result.status === 'skipped-migration-window' ? EXIT_MIGRATION_WINDOW : 1,
);
