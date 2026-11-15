import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Binaries the media slices need and the host may not have: a MinIO server and a static FFmpeg.
// Resolution order: MINIO_BIN / FFMPEG_BIN, then PATH, then a checksum-verified download into a
// cache folder (FOUNDATION_TOOLS_CACHE, default <tmp>/shroomap-foundation-tools).
//
// MinIO stopped publishing server binaries (dl.min.io answers 410) and its own image tags, so the
// download takes the binary out of the last public image that still carries it:
// docker.io/bitnamilegacy/minio:2025.7.23-debian-12-r5 (MinIO RELEASE 2025-07-23, AGPL-3.0).
// FFmpeg is the johnvansickle static build 7.0.2 as repackaged by eugeneware/ffmpeg-static b6.1.1.

const MINIO_IMAGE = { repo: 'bitnamilegacy/minio', tag: '2025.7.23-debian-12-r5' };
const MINIO_SHA256 = '0bf90fb51bb86c5205a0a3569dcbdcb268bf24aa0c59f144a3ffd5e6d67ae85e';
const FFMPEG_URL =
  'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz';
const FFMPEG_GZ_SHA256 = 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa';
const FFMPEG_SHA256 = 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function onPath(name: string): string | null {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function cacheDir(): string {
  const dir = process.env['FOUNDATION_TOOLS_CACHE'] ?? join(tmpdir(), 'shroomap-foundation-tools');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function verified(path: string, expected: string): boolean {
  return existsSync(path) && sha256(readFileSync(path)) === expected;
}

// Minimal tar reader: returns the content of the first regular file whose name ends with `suffix`.
function tarFind(tar: Buffer, suffix: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim();
    const size = parseInt(sizeText || '0', 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const body = offset + 512;
    if ((type === '0' || type === '\0') && name.endsWith(suffix)) {
      return tar.subarray(body, body + size);
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

interface RegistryManifest {
  manifests?: { digest: string; platform?: { architecture?: string } }[];
  layers: { digest: string }[];
}

async function registryJson(url: string, token: string): Promise<RegistryManifest> {
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
  ].join(',');
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept } });
  if (!res.ok) throw new Error(`registry ${url}: ${res.status}`);
  return (await res.json()) as RegistryManifest;
}

async function downloadMinio(target: string): Promise<void> {
  const { repo, tag } = MINIO_IMAGE;
  const auth = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
  );
  const token = ((await auth.json()) as { token: string }).token;
  const base = `https://registry-1.docker.io/v2/${repo}`;
  let manifest = await registryJson(`${base}/manifests/${tag}`, token);
  if (manifest.manifests) {
    const amd64 = manifest.manifests.find((m) => m.platform?.architecture === 'amd64');
    if (!amd64) throw new Error('no amd64 image');
    manifest = await registryJson(`${base}/manifests/${amd64.digest}`, token);
  }
  for (const layer of manifest.layers) {
    const res = await fetch(`${base}/blobs/${layer.digest}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`layer ${layer.digest}: ${res.status}`);
    const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));
    const binary = tarFind(tar, 'bin/minio');
    if (binary) {
      if (sha256(binary) !== MINIO_SHA256) throw new Error('minio binary checksum mismatch');
      writeFileSync(target, binary);
      chmodSync(target, 0o755);
      return;
    }
  }
  throw new Error('minio binary not found in image layers');
}

async function downloadFfmpeg(target: string): Promise<void> {
  const res = await fetch(FFMPEG_URL);
  if (!res.ok) throw new Error(`ffmpeg download: ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  if (sha256(gz) !== FFMPEG_GZ_SHA256) throw new Error('ffmpeg archive checksum mismatch');
  const binary = gunzipSync(gz);
  if (sha256(binary) !== FFMPEG_SHA256) throw new Error('ffmpeg binary checksum mismatch');
  writeFileSync(target, binary);
  chmodSync(target, 0o755);
}

export async function ensureMinio(): Promise<string> {
  const given = process.env['MINIO_BIN'] ?? onPath('minio');
  if (given) return given;
  const target = join(cacheDir(), 'minio');
  if (!verified(target, MINIO_SHA256)) await downloadMinio(target);
  return target;
}

export async function ensureFfmpeg(): Promise<string> {
  const given = process.env['FFMPEG_BIN'] ?? onPath('ffmpeg');
  if (given) return given;
  const target = join(cacheDir(), 'ffmpeg');
  if (!verified(target, FFMPEG_SHA256)) await downloadFfmpeg(target);
  return target;
}
