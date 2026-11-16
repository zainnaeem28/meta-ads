import { describe, expect, it } from 'vitest';
import { configuredOperations } from './operations.js';

describe('configuredOperations', () => {
  it('lists the models the environment names, once each', () => {
    const calls = configuredOperations({
      OPENAI_TEXT_MODEL: 'm1',
      OPENAI_VISION_MODEL: 'm1',
      OPENAI_IMAGE_MODEL: 'img',
      WAVESPEED_MODEL_I2V: 'w/i2v',
    });
    expect(calls).toEqual([
      { provider: 'openai', operation: 'm1' },
      { provider: 'openai', operation: 'img' },
      { provider: 'wavespeed', operation: 'w/i2v' },
    ]);
  });

  it('lists nothing for an empty environment and the registry defaults only on request', () => {
    expect(configuredOperations({})).toEqual([]);
    expect(configuredOperations({ OPENAI_TEXT_MODEL: '' })).toEqual([]);
    expect(configuredOperations({}, true).map((c) => c.operation)).toEqual([
      'gpt-transcribe',
      'bytedance/seedance-2.0/image-to-video',
      'bytedance/seedance-2.0/text-to-video',
    ]);
  });

  it('adds the vendor render only for the vendor adapter', () => {
    expect(configuredOperations({ ASSEMBLY_ADAPTER: 'ffmpeg' })).toEqual([]);
    expect(configuredOperations({ ASSEMBLY_ADAPTER: 'shotstack' })).toEqual([
      { provider: 'assembly_vendor', operation: 'shotstack-render' },
    ]);
  });
});
