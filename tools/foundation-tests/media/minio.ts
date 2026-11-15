import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMinio } from './tools.ts';

export interface MinioHandle {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  version: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// A throwaway MinIO server on random ports with its own data folder and credentials.
export async function startMinio(): Promise<MinioHandle> {
  const bin = await ensureMinio();
  const data = mkdtempSync(join(tmpdir(), 'minio-data-'));
  const port = await freePort();
  const consolePort = await freePort();
  const accessKey = 'foundation-access';
  const secretKey = `s-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const child: ChildProcess = spawn(
    bin,
    [
      'server',
      data,
      '--address',
      `127.0.0.1:${port}`,
      '--console-address',
      `127.0.0.1:${consolePort}`,
    ],
    {
      env: {
        ...process.env,
        MINIO_ROOT_USER: accessKey,
        MINIO_ROOT_PASSWORD: secretKey,
        MINIO_BROWSER: 'off',
      },
      stdio: 'ignore',
    },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${endpoint}/minio/health/ready`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('minio did not become ready in 30 s');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const version = await new Promise<string>((resolve) => {
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', () => resolve(out.split('\n')[0] ?? ''));
  });
  return {
    endpoint,
    accessKey,
    secretKey,
    version,
    stop: async () => {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      });
      rmSync(data, { recursive: true, force: true });
    },
  };
}
