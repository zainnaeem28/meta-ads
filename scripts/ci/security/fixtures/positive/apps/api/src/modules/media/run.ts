// expect: shroomap.process.no-shell-string-spawn
import { exec } from 'node:child_process';

export function run(input: string): void {
  exec(`ffmpeg -i ${input} out.mp4`);
}
