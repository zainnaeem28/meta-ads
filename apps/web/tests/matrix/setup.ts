import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium, firefox, webkit, type FullConfig } from '@playwright/test';
import { RAN, UNAVAILABLE } from './support';

const engines = { chromium, firefox, webkit };

/**
 * Forget the records of an earlier run, then try to start each project's browser. A project whose browser cannot
 * start on this machine (missing system libraries, channel not installed) is recorded with the launch error: its
 * tests skip with that reason and the zero-test rule leaves it out, but the run says so. A project whose browser
 * starts must pass every journey.
 */
export default async function setup(config: FullConfig) {
  rmSync(RAN, { recursive: true, force: true });
  mkdirSync(RAN, { recursive: true });
  const unavailable: Record<string, string> = {};
  for (const project of config.projects) {
    const use = project.use as { defaultBrowserType?: keyof typeof engines; channel?: string };
    const engine = engines[use.defaultBrowserType ?? 'chromium'];
    try {
      const browser = await engine.launch({ channel: use.channel });
      await browser.close();
    } catch (error) {
      unavailable[project.name] =
        String((error as Error).message).split('\n')[0] ?? 'cannot launch';
    }
  }
  writeFileSync(UNAVAILABLE, `${JSON.stringify(unavailable, null, 2)}\n`);
  for (const [name, reason] of Object.entries(unavailable))
    console.warn(`[matrix] NOT EXECUTED: ${name} (${reason})`);
}
