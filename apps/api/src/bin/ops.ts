import 'reflect-metadata';
import { productionRuntime, runOps } from '../platform/ops-cli/index.js';

// The deployer's one-off commands of the release image: `node dist/bin/ops.js <command> --env=<APP_ENV>` (ARCHITECTURE §7.3).
runOps(process.argv.slice(2), productionRuntime())
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`ops failed: ${error instanceof Error ? error.name : 'error'}\n`);
    process.exit(1);
  });
