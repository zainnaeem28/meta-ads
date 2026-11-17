import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AudioExtractor, ExtractedAudio } from '../../application/qc-ports.js';

const TOOL_TIMEOUT_MS = 60_000;
/** 16 kHz mono 16-bit WAV is 32 kB per second: a 15 s clip is under 0.5 MB, the cap leaves room for a longer one. */
const MAX_WAV_BYTES = 32 * 1024 * 1024;

export interface FfmpegBinaries {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

function run(file: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // An argument array and no shell: nothing in the clip's name or bytes reaches a command line.
    execFile(file, [...args], { encoding: 'buffer', timeout: TOOL_TIMEOUT_MS, maxBuffer: MAX_WAV_BYTES, windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(new Error(`${file} failed`));
      else resolve(stdout);
    });
  });
}

/**
 * AudioExtractor over the worker image's FFmpeg and ffprobe (the pinned LGPL build, ARCHITECTURE §5.6): the clip is
 * written to a private temporary directory (an MP4 cannot be read from a pipe), probed for an audio stream and decoded to
 * 16 kHz mono WAV. A file with no audio stream is `none`, not an error. The directory is removed on every path.
 */
export class FfmpegAudio implements AudioExtractor {
  constructor(private readonly binaries: FfmpegBinaries = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }) {}

  async extract(clip: Readable): Promise<ExtractedAudio> {
    const directory = await mkdtemp(join(tmpdir(), 'qc-'));
    try {
      const file = join(directory, 'clip.mp4');
      await pipeline(clip, createWriteStream(file, { mode: 0o600 }));
      const streams = await run(this.binaries.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
      if (streams.toString('utf8').trim() === '') return { kind: 'none' };
      const wav = await run(this.binaries.ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1']);
      return wav.length === 0 ? { kind: 'none' } : { kind: 'audio', wav };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
