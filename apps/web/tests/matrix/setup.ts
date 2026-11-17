import { rmSync } from 'node:fs';
import { RAN } from './support';

/** Forget the records of an earlier run, so the zero-test rule judges this run only. */
export default function setup() {
  rmSync(RAN, { recursive: true, force: true });
}
