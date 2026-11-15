import { secretKeys } from '../config/registry.js';
import type { ProcessConfig } from '../config/schema.js';

/** Every secret-class configuration value this process holds, for literal removal from log text. */
export function secretValuesOf(config: ProcessConfig): string[] {
  const values: string[] = [];
  for (const key of secretKeys()) {
    const value = (config as Record<string, unknown>)[key];
    if (typeof value === 'string') values.push(value);
    else if (value !== undefined && value !== null) values.push(JSON.stringify(value));
  }
  return values;
}
