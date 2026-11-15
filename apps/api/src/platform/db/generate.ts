import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// `pnpm db:generate --name=<NNNN>_<ticket>-<slug>`: drizzle-kit 0.31 with `migrations.prefix: 'none'` writes
// `_<name>.sql` and one `_snapshot.json` that its own reader skips, so every run would re-emit the whole schema.
// This wrapper keeps the default index prefix (snapshots stay diffable), then renames the new migration to the
// exact name given: `0010_task-032-audit.sql`, journal tag `0010_task-032-audit`. `meta/_journal.json` defines
// the order of application; the number is the ticket's reserved range number, not a position.

export const MIGRATION_NAME = /^(\d{4})_(task-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*)$/;

interface Journal {
  entries: { idx: number; tag: string }[];
}

export interface GenerateOptions {
  readonly name: string;
  readonly cwd: string;
  readonly config?: string;
  readonly out?: string;
}

export type GenerateResult = { generated: false } | { generated: true; tag: string };

function readJournal(out: string): Journal {
  const path = join(out, 'meta', '_journal.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Journal) : { entries: [] };
}

export function generateMigration(options: GenerateOptions): GenerateResult {
  const match = MIGRATION_NAME.exec(options.name);
  if (match === null) {
    throw new Error('--name must be <NNNN>_<ticket>-<slug>, for example 0010_task-032-audit');
  }
  const out = resolve(options.cwd, options.out ?? 'src/database/migrations');
  const before = readJournal(out);
  const clash = before.entries.find((entry) => entry.tag.startsWith(`${match[1]}_`));
  if (clash !== undefined)
    throw new Error(`migration number ${match[1]} is already used by ${clash.tag}`);

  const kit = join(options.cwd, 'node_modules', 'drizzle-kit', 'bin.cjs');
  const run = spawnSync(
    process.execPath,
    [
      kit,
      'generate',
      `--config=${options.config ?? 'drizzle.config.ts'}`,
      `--name=${options.name}`,
    ],
    { cwd: options.cwd, encoding: 'utf8', env: process.env },
  );
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0)
    throw new Error(`drizzle-kit generate failed with status ${String(run.status)}`);

  const after = readJournal(out);
  const created = after.entries[before.entries.length];
  if (after.entries.length === before.entries.length || created === undefined) {
    // drizzle-kit exits 0 after printing some failures, so only its own "nothing to do" message is accepted.
    if (!run.stdout.includes('No schema changes')) {
      throw new Error(
        'drizzle-kit generate wrote no migration and did not report "No schema changes"',
      );
    }
    return { generated: false };
  }
  renameSync(join(out, `${created.tag}.sql`), join(out, `${options.name}.sql`));
  created.tag = options.name;
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify(after, null, 2));
  return { generated: true, tag: options.name };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const name = process.argv.find((arg) => arg.startsWith('--name='))?.slice('--name='.length) ?? '';
  try {
    const result = generateMigration({ name, cwd: process.cwd() });
    process.stdout.write(result.generated ? `generated ${result.tag}\n` : 'no schema changes\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'generate failed'}\n`);
    process.exit(1);
  }
}
