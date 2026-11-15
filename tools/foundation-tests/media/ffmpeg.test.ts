import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFfmpeg } from './tools.ts';

// F-ASM (ARCHITECTURE §5.7): FFmpeg concat of four 15 s 1080x1920 clips, re-encoded to
// H.264/AAC 1080x1920 30 fps. Measures wall time and peak RSS (VmHWM of the ffmpeg process) and
// compares them with the G1 estimate of 10-60 s on the Standard (2 GB) worker size.

let ffmpeg: string;
let dir: string;
const clips: string[] = [];

function run(
  bin: string,
  args: string[],
  options: { cpu0?: boolean } = {},
): Promise<{ code: number; ms: number; peakRssKb: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const command = options.cpu0 ? 'taskset' : bin;
    const argv = options.cpu0 ? ['-c', '0', bin, ...args] : args;
    const started = Date.now();
    const child = spawn(command, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    let peak = 0;
    const timer = setInterval(() => {
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const hwm = /VmHWM:\s+(\d+) kB/.exec(status);
        if (hwm) peak = Math.max(peak, Number(hwm[1]));
      } catch {
        // process already gone
      }
    }, 25);
    child.on('error', reject);
    child.on('close', (code) => {
      clearInterval(timer);
      resolve({ code: code ?? -1, ms: Date.now() - started, peakRssKb: peak, stderr });
    });
  });
}

beforeAll(async () => {
  ffmpeg = await ensureFfmpeg();
  dir = mkdtempSync(join(tmpdir(), 'ffmpeg-slice-'));
  // four distinct 15 s 1080x1920 30 fps clips with audio, like the Seedance outputs
  const patterns = ['testsrc2', 'smptebars', 'mandelbrot', 'rgbtestsrc'];
  for (const [i, pattern] of patterns.entries()) {
    const out = join(dir, `clip${i}.mp4`);
    const source =
      pattern === 'mandelbrot'
        ? `mandelbrot=size=1080x1920:rate=30`
        : `${pattern}=size=1080x1920:rate=30`;
    const r = await run(ffmpeg, [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      source,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${220 * (i + 1)}:sample_rate=48000`,
      '-t',
      '15',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      out,
    ]);
    if (r.code !== 0) throw new Error(`fixture clip ${i} failed: ${r.stderr.slice(-400)}`);
    clips.push(out);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function concatArgs(list: string, out: string, threads?: number): string[] {
  return [
    '-hide_banner',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    'scale=1080:1920,fps=30,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    ...(threads ? ['-threads', String(threads)] : []),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    out,
  ];
}

const results: Record<string, { seconds: number; peakRssMb: number }> = {};

describe('FFmpeg concat of four 15 s 1080x1920 clips', () => {
  it('fixtures are 15 s 1080x1920', async () => {
    const probe = await run(ffmpeg, ['-hide_banner', '-i', clips[0] as string, '-f', 'null', '-']);
    expect(probe.stderr).toMatch(/Duration: 00:00:15/);
    expect(probe.stderr).toMatch(/1080x1920/);
  });

  for (const scenario of [
    { name: 'all host cores', cpu0: false },
    { name: '1 vCPU (taskset -c 0, the Standard size)', cpu0: true },
  ]) {
    it(`renders 60 s H.264/AAC in the 10 min limit on ${scenario.name}`, async () => {
      const list = join(dir, 'list.txt');
      writeFileSync(list, clips.map((c) => `file '${c}'`).join('\n'));
      const out = join(dir, scenario.cpu0 ? 'out-1cpu.mp4' : 'out-all.mp4');
      const r = await run(ffmpeg, concatArgs(list, out), { cpu0: scenario.cpu0 });
      expect(r.code, r.stderr.slice(-600)).toBe(0);
      const seconds = r.ms / 1000;
      const peakRssMb = r.peakRssKb / 1024;
      results[scenario.name] = { seconds, peakRssMb };
      console.log(
        `FFMPEG ${scenario.name}: ${seconds.toFixed(1)} s, peak RSS ${peakRssMb.toFixed(0)} MB, output ${(statSync(out).size / 1e6).toFixed(1)} MB, host cores ${cpus().length}`,
      );
      // output is 60 s, 1080x1920, h264 + aac
      const probe = await run(ffmpeg, ['-hide_banner', '-i', out, '-f', 'null', '-']);
      expect(probe.stderr).toMatch(/Duration: 00:01:00/);
      expect(probe.stderr).toMatch(/Video: h264.*1080x1920.*30 fps/);
      expect(probe.stderr).toMatch(/Audio: aac/);
      expect(seconds).toBeLessThan(600); // F-ASM render time limit
      expect(peakRssMb).toBeLessThan(1500); // headroom inside the 2 GB Standard worker, which also runs Node
    });
  }

  it('records the measurement for the stack-validation document', () => {
    const outDir = join(import.meta.dirname, '..', '..', '..', 'reports', 'foundation');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'slices-b-ffmpeg.json'),
      JSON.stringify({ hostCores: cpus().length, cpuModel: cpus()[0]?.model, results }, null, 2),
    );
    expect(Object.keys(results)).toHaveLength(2);
  });
});
