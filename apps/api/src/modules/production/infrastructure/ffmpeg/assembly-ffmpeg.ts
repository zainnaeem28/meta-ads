import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { AssemblyRenderError } from '../../application/worker/assembly-ports.js';
import type {
  AssemblyPort,
  AssemblyProgress,
  AssemblyRenderInput,
} from '../../application/worker/assembly-ports.js';

export interface AssemblyBinaries {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export interface FfmpegAssemblyOptions {
  readonly binaries?: AssemblyBinaries;
  /** Seconds the opening frame is shown (`THUMBSTOPPER_FRAME_SECONDS`). */
  readonly frameSeconds: number;
  /** A render running longer than this is killed and ends `timeout`. */
  readonly timeoutMs?: number;
  /** The H.264 encoder of the pinned LGPL build (ARCHITECTURE §5.7): OpenH264, since x264 is GPL. */
  readonly videoEncoder?: string;
}

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const FRAME_RATE = 30;
const SAMPLE_RATE = 48_000;

interface Probed {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly hasAudio: boolean;
}

interface RunOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly onStdout?: (chunk: string) => void;
  readonly maxStdoutBytes?: number;
}

/** The process ended without a result because the caller asked it to stop. */
export class AssemblyAborted extends Error {
  constructor() {
    super('the render was stopped');
    this.name = 'AssemblyAborted';
  }
}

/**
 * Runs one program with an argument array and no shell (nothing in a file name or a clip's bytes reaches a command line),
 * killing it when the time is up or the caller aborts. Resolves with the exit code; the program's own output is read only
 * through `onStdout` and is never put in an error message.
 */
function run(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new AssemblyAborted());
      return;
    }
    const child = spawn(file, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let timedOut = false;
    let aborted = false;
    let received = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      received += chunk.length;
      if (options.maxStdoutBytes !== undefined && received > options.maxStdoutBytes) {
        child.kill('SIGKILL');
        return;
      }
      options.onStdout?.(chunk);
    });
    const done = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (error) => {
      done();
      reject(error);
    });
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      done();
      child.stdout.destroy();
      if (aborted) reject(new AssemblyAborted());
      else resolve({ code, timedOut });
    };
    // A killed program may leave a grandchild holding the pipe open: its exit alone ends the wait.
    child.once('exit', (code) => {
      if (timedOut || aborted) settle(code);
    });
    child.once('close', settle);
  });
}

/**
 * AssemblyPort over the worker image's FFmpeg and ffprobe (the pinned static LGPL build, ARCHITECTURE §5.7, ADR-006): the
 * clips (and the optional opening frame) are probed, scaled to the first clip's size, joined with `concat`, and encoded to
 * an MP4 (OpenH264 and AAC) at the given local path. A clip without sound gets silence of its length, so the join never
 * drops audio. Progress is read from `-progress` and reported as a fraction of the final length. Everything is local files.
 */
export class FfmpegAssembly implements AssemblyPort {
  private readonly binaries: AssemblyBinaries;
  private readonly timeoutMs: number;
  private readonly encoder: string;

  constructor(private readonly options: FfmpegAssemblyOptions) {
    this.binaries = options.binaries ?? { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.encoder = options.videoEncoder ?? 'libopenh264';
  }

  async render(
    input: AssemblyRenderInput,
    onProgress: (progress: AssemblyProgress) => void,
  ): Promise<{ readonly bytes: number }> {
    if (input.clips.length === 0) throw new AssemblyRenderError('render_failed', 'no clips');
    const probed: Probed[] = [];
    for (const clip of input.clips) probed.push(await this.probe(clip, input.signal));
    const frameSeconds = input.openingFrame === null ? 0 : this.options.frameSeconds;
    const total = probed.reduce((sum, clip) => sum + clip.seconds, frameSeconds);
    const args = this.arguments(input, probed);

    let buffered = '';
    const read = (chunk: string): void => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const microseconds = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
        if (microseconds === null || total <= 0) continue;
        onProgress({ fraction: Math.min(1, Number(microseconds[1]) / 1_000_000 / total) });
      }
    };
    const result = await run(this.binaries.ffmpeg, args, {
      timeoutMs: this.timeoutMs,
      signal: input.signal,
      onStdout: read,
    });
    if (result.timedOut) throw new AssemblyRenderError('timeout', 'the render took too long');
    if (result.code !== 0)
      throw new AssemblyRenderError('render_failed', `ffmpeg exited with ${String(result.code)}`);
    const bytes = await stat(input.output).then(
      (file) => file.size,
      () => 0,
    );
    if (bytes === 0) throw new AssemblyRenderError('render_failed', 'ffmpeg wrote no output');
    onProgress({ fraction: 1 });
    return { bytes };
  }

  /** Size, length and sound of one clip. A file ffprobe cannot read is an input problem, not a render one. */
  private async probe(file: string, signal: AbortSignal | undefined): Promise<Probed> {
    let out = '';
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_entries',
      'stream=codec_type,width,height:format=duration',
      file,
    ];
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(this.binaries.ffprobe, args, {
        timeoutMs: PROBE_TIMEOUT_MS,
        signal,
        maxStdoutBytes: PROBE_MAX_BYTES,
        onStdout: (chunk) => (out += chunk),
      });
    } catch (error) {
      // Stopped, or the program itself is missing: not the clip's fault, so not a final answer for the job.
      if (error instanceof AssemblyAborted || (error as NodeJS.ErrnoException).code === 'ENOENT')
        throw error;
      throw new AssemblyRenderError('input_unavailable', 'a clip could not be probed');
    }
    if (result.code !== 0)
      throw new AssemblyRenderError('input_unavailable', 'a clip could not be read');
    let doc: {
      streams?: { codec_type?: string; width?: number; height?: number }[];
      format?: { duration?: string };
    };
    try {
      doc = JSON.parse(out) as typeof doc;
    } catch {
      throw new AssemblyRenderError('input_unavailable', 'a clip could not be read');
    }
    const video = doc.streams?.find((stream) => stream.codec_type === 'video');
    const seconds = Number(doc.format?.duration);
    if (
      video?.width === undefined ||
      video.height === undefined ||
      !Number.isFinite(seconds) ||
      seconds <= 0
    ) {
      throw new AssemblyRenderError('input_unavailable', 'a clip has no video');
    }
    return {
      width: video.width,
      height: video.height,
      seconds,
      hasAudio: doc.streams?.some((stream) => stream.codec_type === 'audio') === true,
    };
  }

  /** The whole command line, as an array. */
  private arguments(input: AssemblyRenderInput, probed: readonly Probed[]): string[] {
    const first = probed[0] as Probed;
    // Even sizes: H.264 4:2:0 needs them.
    const width = first.width - (first.width % 2);
    const height = first.height - (first.height % 2);
    const args = ['-v', 'error', '-nostdin', '-nostats', '-progress', 'pipe:1', '-y'];
    const filters: string[] = [];
    const joined: string[] = [];
    const picture = (source: string, label: string): string =>
      `[${source}]scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${String(FRAME_RATE)},format=yuv420p[${label}]`;
    const silence = (seconds: number, label: string): string =>
      `anullsrc=r=${String(SAMPLE_RATE)}:cl=stereo,atrim=duration=${seconds.toFixed(3)},asetpts=N/SR/TB[${label}]`;
    let index = 0;
    let part = 0;
    if (input.openingFrame !== null) {
      args.push(
        '-loop',
        '1',
        '-framerate',
        String(FRAME_RATE),
        '-t',
        String(this.options.frameSeconds),
        '-i',
        input.openingFrame,
      );
      filters.push(
        picture(`${String(index)}:v`, `v${String(part)}`),
        silence(this.options.frameSeconds, `a${String(part)}`),
      );
      joined.push(`[v${String(part)}][a${String(part)}]`);
      index += 1;
      part += 1;
    }
    input.clips.forEach((clip, position) => {
      const info = probed[position] as Probed;
      args.push('-i', clip);
      filters.push(picture(`${String(index)}:v:0`, `v${String(part)}`));
      filters.push(
        info.hasAudio
          ? `[${String(index)}:a:0]aresample=${String(SAMPLE_RATE)},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB[a${String(part)}]`
          : silence(info.seconds, `a${String(part)}`),
      );
      joined.push(`[v${String(part)}][a${String(part)}]`);
      index += 1;
      part += 1;
    });
    filters.push(`${joined.join('')}concat=n=${String(part)}:v=1:a=1[v][a]`);
    args.push(
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      this.encoder,
      '-b:v',
      '6M',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      input.output,
    );
    return args;
  }
}
