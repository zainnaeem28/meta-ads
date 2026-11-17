import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssemblyRenderError } from '../../application/worker/assembly-ports.js';
import { AssemblyAborted, FfmpegAssembly } from './assembly-ffmpeg.js';

// The adapter's own work: the argument array (no shell), the probe, the filter graph, progress, the failure causes and the
// stop paths, against fake ffprobe and ffmpeg scripts; and one render with the real binaries when they are installed
// (FFMPEG_DIR, or on the PATH: the worker image has them).

let dir: string;
let calls: string;
const script = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
const PROBE = `printf '{"streams":[{"codec_type":"video","width":321,"height":569},{"codec_type":"audio"}],"format":{"duration":"15.0"}}'`;
const probeWith = (body: string): string => script(`probe-${String(Math.random()).slice(2)}`, body);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'asm-adapter-'));
  calls = join(dir, 'calls.log');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const noop = (): void => undefined;
const clips = (...names: string[]): string[] => names.map((name) => join(dir, name));

describe('FfmpegAssembly (fake binaries)', () => {
  it('runs ffmpeg with an argument array, no shell: a hostile file name stays one argument', async () => {
    const hostile = join(dir, 'a b; touch pwned $(id) `x`.mp4');
    const output = join(dir, 'out-1.mp4');
    const ffmpeg = script(
      'ffmpeg-ok',
      `: > ${calls}\nfor a; do printf '%s\\n' "$a" >> ${calls}; out="$a"; done\nprintf 'video' > "$out"\nprintf 'out_time_us=15000000\\nout_time_us=60000000\\n'`,
    );
    const seen: number[] = [];
    const result = await new FfmpegAssembly({
      binaries: { ffmpeg, ffprobe: probeWith(PROBE) },
      frameSeconds: 1.5,
    }).render(
      { clips: [hostile, ...clips('b.mp4', 'c.mp4', 'd.mp4')], openingFrame: null, output },
      (progress) => seen.push(progress.fraction),
    );
    expect(result).toEqual({ bytes: 5 });
    const args = readFileSync(calls, 'utf8').split('\n');
    expect(args).toContain(hostile);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(4);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('concat=n=4:v=1:a=1[v][a]');
    // The first clip sets the size (rounded down to even numbers).
    expect(graph).toContain('scale=320:568');
    expect(args).toEqual(
      expect.arrayContaining(['-c:v', 'libopenh264', '-c:a', 'aac', '-f', 'mp4', output]),
    );
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    expect(seen).toEqual([0.25, 1, 1]);
  });

  it('adds silence for a clip without sound and the opening frame as a still of the configured length', async () => {
    const silent = probeWith(
      `printf '{"streams":[{"codec_type":"video","width":320,"height":568}],"format":{"duration":"12.5"}}'`,
    );
    const ffmpeg = script(
      'ffmpeg-args',
      `: > ${calls}\nfor a; do printf '%s\\n' "$a" >> ${calls}; out="$a"; done\nprintf 'video' > "$out"`,
    );
    await new FfmpegAssembly({ binaries: { ffmpeg, ffprobe: silent }, frameSeconds: 2 }).render(
      {
        clips: clips('a.mp4'),
        openingFrame: join(dir, 'frame.png'),
        output: join(dir, 'out-2.mp4'),
      },
      noop,
    );
    const args = readFileSync(calls, 'utf8').split('\n');
    expect(args.slice(args.indexOf('-loop'), args.indexOf('-loop') + 8)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '2',
      '-i',
      join(dir, 'frame.png'),
    ]);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=12.500');
    expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=2.000');
    expect(graph).toContain('concat=n=2:v=1:a=1[v][a]');
  });

  it('ends render_failed when ffmpeg exits with an error or writes nothing, without its output in the message', async () => {
    const probe = probeWith(PROBE);
    const failing = script('ffmpeg-fail', `echo 'secret path /home/x/clip.mp4' >&2\nexit 1`);
    const error = await new FfmpegAssembly({
      binaries: { ffmpeg: failing, ffprobe: probe },
      frameSeconds: 1.5,
    })
      .render({ clips: clips('a.mp4'), openingFrame: null, output: join(dir, 'out-3.mp4') }, noop)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssemblyRenderError);
    expect(error).toMatchObject({ causeClass: 'render_failed' });
    expect((error as Error).message).not.toContain('secret');
    const empty = script('ffmpeg-empty', 'exit 0');
    await expect(
      new FfmpegAssembly({ binaries: { ffmpeg: empty, ffprobe: probe }, frameSeconds: 1.5 }).render(
        { clips: clips('a.mp4'), openingFrame: null, output: join(dir, 'never.mp4') },
        noop,
      ),
    ).rejects.toMatchObject({ causeClass: 'render_failed' });
    await expect(
      new FfmpegAssembly({ binaries: { ffmpeg: empty, ffprobe: probe }, frameSeconds: 1.5 }).render(
        { clips: [], openingFrame: null, output: join(dir, 'never.mp4') },
        noop,
      ),
    ).rejects.toMatchObject({ causeClass: 'render_failed' });
  });

  it('ends input_unavailable when a clip cannot be probed: an error, no JSON, no video, or no length', async () => {
    const ffmpeg = script('ffmpeg-unused', 'exit 0');
    for (const body of [
      'exit 1',
      `printf 'not json'`,
      `printf '{"streams":[{"codec_type":"audio"}],"format":{"duration":"3"}}'`,
      `printf '{"streams":[{"codec_type":"video","width":4,"height":4}],"format":{}}'`,
    ]) {
      await expect(
        new FfmpegAssembly({
          binaries: { ffmpeg, ffprobe: probeWith(body) },
          frameSeconds: 1.5,
        }).render(
          { clips: clips('a.mp4'), openingFrame: null, output: join(dir, 'never.mp4') },
          noop,
        ),
      ).rejects.toMatchObject({ causeClass: 'input_unavailable' });
    }
  });

  it('kills a render that runs too long and ends it timeout', async () => {
    const hang = script('ffmpeg-hang', 'sleep 30');
    const started = Date.now();
    await expect(
      new FfmpegAssembly({
        binaries: { ffmpeg: hang, ffprobe: probeWith(PROBE) },
        frameSeconds: 1.5,
        timeoutMs: 300,
      }).render(
        { clips: clips('a.mp4'), openingFrame: null, output: join(dir, 'never.mp4') },
        noop,
      ),
    ).rejects.toMatchObject({ causeClass: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops when told to, killing ffmpeg, and not at all when already told', async () => {
    const hang = script('ffmpeg-hang-2', 'sleep 30');
    const adapter = new FfmpegAssembly({
      binaries: { ffmpeg: hang, ffprobe: probeWith(PROBE) },
      frameSeconds: 1.5,
    });
    const stop = new AbortController();
    const pending = adapter.render(
      {
        clips: clips('a.mp4'),
        openingFrame: null,
        output: join(dir, 'never.mp4'),
        signal: stop.signal,
      },
      noop,
    );
    setTimeout(() => stop.abort(), 300);
    await expect(pending).rejects.toBeInstanceOf(AssemblyAborted);
    await expect(
      adapter.render(
        {
          clips: clips('a.mp4'),
          openingFrame: null,
          output: join(dir, 'never.mp4'),
          signal: stop.signal,
        },
        noop,
      ),
    ).rejects.toBeInstanceOf(AssemblyAborted);
  });

  it('throws a plain error (retried) when the binary itself is missing', async () => {
    const error = await new FfmpegAssembly({
      binaries: { ffmpeg: join(dir, 'nope'), ffprobe: join(dir, 'nope-too') },
      frameSeconds: 1.5,
    })
      .render({ clips: clips('a.mp4'), openingFrame: null, output: join(dir, 'never.mp4') }, noop)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AssemblyRenderError);
    expect(error).toMatchObject({ code: 'ENOENT' });
  });
});

const realDir = [process.env['FFMPEG_DIR'], ...(process.env['PATH'] ?? '').split(delimiter)].find(
  (candidate) =>
    candidate !== undefined &&
    candidate !== '' &&
    ['ffmpeg', 'ffprobe'].every(
      (name) =>
        existsSync(join(candidate, name)) &&
        spawnSync(join(candidate, name), ['-version'], { stdio: 'ignore' }).status === 0,
    ),
);

describe.skipIf(realDir === undefined)('FfmpegAssembly (the real binaries)', () => {
  it('joins four 15 second clips, one without sound, behind an opening frame, into one playable MP4', async () => {
    const work = mkdtempSync(join(tmpdir(), 'asm-real-'));
    try {
      const run = (name: string, args: string[]): string => {
        const result = spawnSync(join(realDir as string, name), args, { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`${name}: ${result.stderr}`);
        return result.stdout;
      };
      const files: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const file = join(work, `clip-${String(index)}.mp4`);
        const audio =
          index === 2
            ? []
            : [
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=440:sample_rate=44100:duration=15',
                '-c:a',
                'aac',
              ];
        run('ffmpeg', [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=320x568:rate=24:duration=15',
          ...audio,
          '-c:v',
          'mpeg4',
          '-pix_fmt',
          'yuv420p',
          '-y',
          file,
        ]);
        files.push(file);
      }
      const frame = join(work, 'frame.png');
      run('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=640x640:duration=1',
        '-frames:v',
        '1',
        '-y',
        frame,
      ]);
      const output = join(work, 'final.mp4');
      const seen: number[] = [];
      const result = await new FfmpegAssembly({
        binaries: {
          ffmpeg: join(realDir as string, 'ffmpeg'),
          ffprobe: join(realDir as string, 'ffprobe'),
        },
        frameSeconds: 1.5,
      }).render({ clips: files, openingFrame: frame, output }, (progress) =>
        seen.push(progress.fraction),
      );
      expect(result.bytes).toBeGreaterThan(1000);
      const info = JSON.parse(
        run('ffprobe', [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_entries',
          'stream=codec_type,codec_name,width,height:format=duration,format_name',
          output,
        ]),
      ) as {
        streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
        format: { duration: string; format_name: string };
      };
      expect(Number(info.format.duration)).toBeGreaterThan(61);
      expect(Number(info.format.duration)).toBeLessThan(62.5);
      expect(info.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
        codec_name: 'h264',
        width: 320,
        height: 568,
      });
      expect(info.streams.find((stream) => stream.codec_type === 'audio')).toMatchObject({
        codec_name: 'aac',
      });
      expect(seen.at(-1)).toBe(1);
      // Decoding the whole file end to end finds no error: it is playable.
      run('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
