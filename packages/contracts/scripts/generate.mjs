// Regenerates packages/contracts/src/generated from openapi.yaml. Usage: node scripts/generate.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import yaml from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(root, 'src/generated'));
const bin = (name) => join(root, 'node_modules/.bin', name);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

const work = join(root, '.generate-tmp');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'src/generated'), { recursive: true });
cpSync(join(root, 'src/http.ts'), join(work, 'src/http.ts'));
cpSync(join(root, 'openapi.yaml'), join(work, 'openapi.yaml'));
cpSync(join(root, 'orval.config.mjs'), join(work, 'orval.config.mjs'));

try {
  run(bin('openapi-typescript'), [
    'openapi.yaml',
    '--redocly',
    'scripts/generate.redocly.yaml',
    '-o',
    join(work, 'src/generated/schema.d.ts'),
  ]);
  execFileSync(bin('orval'), ['--config', 'orval.config.mjs'], { cwd: work, stdio: 'inherit' });
  const codes = yaml.load(readFileSync(join(root, 'openapi.yaml'), 'utf8')).components.schemas
    .ErrorCode.enum;
  const body = [
    '// Generated from openapi.yaml components.schemas.ErrorCode. Do not edit.',
    `export const ERROR_CODES = [${codes.map((c) => `'${c}'`).join(', ')}] as const;`,
    'export type ErrorCodeValue = (typeof ERROR_CODES)[number];',
    '',
  ].join('\n');
  writeFileSync(join(work, 'src/generated/error-codes.ts'), body);
  run(join(root, '../../node_modules/.bin/prettier'), ['--write', join(work, 'src/generated')]);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(work, 'src/generated'), outDir, { recursive: true });
} finally {
  rmSync(work, { recursive: true, force: true });
}
