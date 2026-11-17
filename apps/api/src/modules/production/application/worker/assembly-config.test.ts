import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assemblyMediaOf, assemblyWorkerConfigFrom } from '../../production.module.js';

// TASK-056 start-up checks: Shotstack was descoped (OD-08), so the only adapter is ffmpeg; the two settings are range-checked.

describe('assemblyWorkerConfigFrom', () => {
  it('defaults to the ffmpeg adapter, one render at a time and a 1.5 second opening frame', () => {
    expect(assemblyWorkerConfigFrom({})).toMatchObject({
      concurrency: 1,
      frameSeconds: 1.5,
      maxAttempts: 3,
      leaseSec: 120,
    });
    expect(
      assemblyWorkerConfigFrom({
        ASSEMBLY_ADAPTER: 'ffmpeg',
        ASSEMBLY_CONCURRENCY: '4',
        THUMBSTOPPER_FRAME_SECONDS: '5',
      }),
    ).toMatchObject({ concurrency: 4, frameSeconds: 5 });
  });

  it('stops the process naming the setting when it is out of range or names an adapter that is not built', () => {
    expect(() => assemblyWorkerConfigFrom({ ASSEMBLY_ADAPTER: 'shotstack' })).toThrow(
      'ASSEMBLY_ADAPTER=shotstack is not available',
    );
    expect(() => assemblyWorkerConfigFrom({ ASSEMBLY_CONCURRENCY: '5' })).toThrow(
      'ASSEMBLY_CONCURRENCY',
    );
    expect(() => assemblyWorkerConfigFrom({ THUMBSTOPPER_FRAME_SECONDS: '0.4' })).toThrow(
      'THUMBSTOPPER_FRAME_SECONDS',
    );
    expect(() => assemblyWorkerConfigFrom({ THUMBSTOPPER_FRAME_SECONDS: 'x' })).toThrow(
      'THUMBSTOPPER_FRAME_SECONDS',
    );
  });
});

describe('assemblyMediaOf', () => {
  it('registers the final video as a ready MP4 of the campaign', async () => {
    const seen: unknown[] = [];
    const media = assemblyMediaOf(() => ({
      registerObject: (_tx, input) => (seen.push(input), Promise.resolve('x')),
    }));
    await media.registerFinal({} as never, {
      id: 'a',
      ownerId: 'o',
      campaignId: 'c',
      storageKey: 'u/o/c/c/final/a.mp4',
      bytes: 9,
    });
    expect(seen).toEqual([
      {
        id: 'a',
        ownerId: 'o',
        kind: 'final',
        storageKey: 'u/o/c/c/final/a.mp4',
        bytes: 9,
        contentType: 'video/mp4',
        campaignId: 'c',
      },
    ]);
  });
});

describe('the FFmpeg adapter source', () => {
  it('never runs a shell or builds a command line from a string (TASK-056 lint)', () => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../infrastructure/ffmpeg/assembly-ffmpeg.ts',
    );
    const source = readFileSync(file, 'utf8');
    expect(source).toMatch(/spawn\(file, \[\.\.\.args\], \{ shell: false/);
    expect(source).not.toMatch(/(?<![.\w])exec(Sync|File|FileSync)?\(/);
    expect(source).not.toMatch(/shell:\s*true/);
    expect(source).not.toMatch(/import\s+(\*|\{[^}]*\bexec\b)/);
  });
});
