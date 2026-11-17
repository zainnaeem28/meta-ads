import { rmSync } from 'node:fs';
import { LEDGER } from './cells.js';

/** Every run starts with an empty ledger of observed replies (the gate reads it after the run). */
export default function setup(): void {
  rmSync(LEDGER, { force: true });
}
