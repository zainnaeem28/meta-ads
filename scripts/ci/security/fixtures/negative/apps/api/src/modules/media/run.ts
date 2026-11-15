// expect: none
import { execFile } from 'node:child_process';

export function run(input: string): void {
  execFile('ffmpeg', ['-i', input, 'out.mp4'], { shell: false }, () => undefined);
}
