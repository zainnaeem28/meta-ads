import { describe, expect, it } from 'vitest';
import { SeedRefusedError, authorizeDataset, parseDataset } from './seed.js';

describe('seed authorization', () => {
  it('parses --dataset and refuses anything else', () => {
    expect(parseDataset(['--dataset=reference'])).toBe('reference');
    expect(parseDataset(['x', '--dataset=staging'])).toBe('staging');
    expect(() => parseDataset([])).toThrow(SeedRefusedError);
    expect(() => parseDataset(['--dataset=production'])).toThrow('--dataset must be one of');
  });

  it('matches each dataset to its environment; production takes reference only', () => {
    for (const env of ['development', 'test', 'staging', 'production'] as const) {
      expect(() => authorizeDataset('reference', env)).not.toThrow();
    }
    expect(() => authorizeDataset('development', 'development')).not.toThrow();
    expect(() => authorizeDataset('staging', 'staging')).not.toThrow();
    expect(() => authorizeDataset('development', 'staging')).toThrow('APP_ENV=development');
    expect(() => authorizeDataset('staging', 'production')).toThrow('APP_ENV=staging');
    expect(() => authorizeDataset('development', 'production')).toThrow(SeedRefusedError);
  });
});
