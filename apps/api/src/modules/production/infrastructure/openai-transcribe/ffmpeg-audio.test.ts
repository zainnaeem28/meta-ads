import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegAudio } from './ffmpeg-audio.js';

// The extractor's own work (private temp file, an argument array, the probe, the decode, the clean-up) against fake
// ffprobe and ffmpeg scripts; the real binaries are in the worker image and are not on a developer's machine.

let dir: string;
let calls: string;
const script = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-ffmpeg-'));
  calls = join(dir, 'calls.log');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const qcTemp = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('qc-'));

describe('FfmpegAudio', () => {
  it('writes the clip to a private file, probes it and decodes the audio to WAV, then removes the file', async () => {
    const probe = script('probe-audio', `echo "$@" >> ${calls}\nprintf '1\\n'`);
    const ffmpeg = script('ffmpeg-ok', `echo "$@" >> ${calls}\nprintf 'RIFFwavbytes'`);
    const before = qcTemp().length;
    const out = await new FfmpegAudio({ ffmpeg, ffprobe: probe }).extract(Readable.from([Buffer.from('mp4-bytes')]));
    expect(out).toEqual({ kind: 'audio', wav: Buffer.from('RIFFwavbytes') });
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain('-select_streams a');
    expect(log).toContain('-vn -ac 1 -ar 16000 -f wav pipe:1');
    expect(qcTemp().length).toBe(before);
  });

  it('answers none for a file with no audio stream, without decoding', async () => {
    const probe = script('probe-none', 'printf ""');
    const ffmpeg = script('ffmpeg-never', 'exit 9');
    expect(await new FfmpegAudio({ ffmpeg, ffprobe: probe }).extract(Readable.from([Buffer.from('x')]))).toEqual({ kind: 'none' });
  });

  it('answers none when the decode yields no bytes', async () => {
    const probe = script('probe-one', "printf '1'");
    const ffmpeg = script('ffmpeg-empty', 'printf ""');
    expect(await new FfmpegAudio({ ffmpeg, ffprobe: probe }).extract(Readable.from([Buffer.from('x')]))).toEqual({ kind: 'none' });
  });

  it('throws when a tool fails, and still removes the file', async () => {
    const probe = script('probe-bad', 'exit 1');
    const before = qcTemp().length;
    await expect(new FfmpegAudio({ ffmpeg: 'ffmpeg', ffprobe: probe }).extract(Readable.from([Buffer.from('x')]))).rejects.toThrow('failed');
    expect(qcTemp().length).toBe(before);
  });
});
