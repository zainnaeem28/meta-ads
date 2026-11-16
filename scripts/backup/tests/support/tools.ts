import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `age` and `age-keygen` for the tests: AGE_BIN / AGE_KEYGEN_BIN, then PATH, then the official release archive
// (FiloSottile/age v1.2.1, linux amd64) downloaded once into a cache folder and checked against a pinned SHA-256.
const AGE_URL =
  'https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz';
const AGE_SHA256 = '7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50';

function onPath(name: string): string | null {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export async function ensureAge(): Promise<{ age: string; keygen: string }> {
  const age = process.env['AGE_BIN'] ?? onPath('age');
  const keygen = process.env['AGE_KEYGEN_BIN'] ?? onPath('age-keygen');
  if (age && keygen) return { age, keygen };
  const dir = join(
    process.env['FOUNDATION_TOOLS_CACHE'] ?? join(tmpdir(), 'shroomap-foundation-tools'),
    'age-1.2.1',
  );
  const target = { age: join(dir, 'age'), keygen: join(dir, 'age-keygen') };
  if (existsSync(target.age) && existsSync(target.keygen)) return target;
  mkdirSync(dir, { recursive: true });
  const res = await fetch(AGE_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`age download: ${res.status}`);
  const archive = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== AGE_SHA256)
    throw new Error('age archive checksum mismatch');
  const file = join(dir, 'age.tgz');
  writeFileSync(file, archive);
  execFileSync('tar', ['-xzf', file, '-C', dir, '--strip-components=1']);
  chmodSync(target.age, 0o755);
  chmodSync(target.keygen, 0o755);
  return target;
}

export interface AgeKey {
  recipient: string;
  identityFile: string;
}

export function generateAgeKey(keygen: string, dir: string): AgeKey {
  const identityFile = join(dir, 'escrowed-age-identity.txt');
  const out = execFileSync(keygen, ['-o', identityFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = out + readFileSync(identityFile, 'utf8');
  const recipient = /age1[0-9a-z]{58}/.exec(text)?.[0];
  if (recipient === undefined) throw new Error('age-keygen printed no recipient');
  return { recipient, identityFile };
}
