import { describe, expect, it } from 'vitest';
import { thumbConfigFrom, thumbMediaOf } from '../production.module.js';

describe('thumbConfigFrom', () => {
  it('has no model when the process has none, and the registry defaults otherwise', () => {
    expect(thumbConfigFrom({})).toEqual({
      imageModel: undefined,
      deadlineMinutes: 5,
      idempotencyTtlHours: 24,
      orphanAfterSec: 300,
      requeueAfterSec: 120,
      outputMaxBytes: 209_715_200,
    });
  });

  it('reads the model, and points the call at a stand-in only when given a base URL', () => {
    const config = thumbConfigFrom({ OPENAI_IMAGE_MODEL: 'gpt-image-1', PROVIDER_OUTPUT_MAX_BYTES: '1000' }, 'https://api.openai.com:9443');
    expect(config).toMatchObject({ imageModel: 'gpt-image-1', outputMaxBytes: 1000, imageUrl: 'https://api.openai.com:9443/v1/images/generations' });
  });

  it.each(['gpt image', 'a/b', '-x'])('stops the process, naming the variable, for OPENAI_IMAGE_MODEL=%s', (value) => {
    expect(() => thumbConfigFrom({ OPENAI_IMAGE_MODEL: value })).toThrow('OPENAI_IMAGE_MODEL');
  });
});

describe('thumbMediaOf', () => {
  it('records the image as a thumbstopper object of the campaign through the media module', async () => {
    const seen: unknown[] = [];
    const media = thumbMediaOf(() => ({ registerObject: async (_tx, input) => { seen.push(input); return input.id ?? ''; } }));
    await media.registerImage({} as never, { id: 'i', ownerId: 'o', campaignId: 'c', storageKey: 'k', bytes: 5, contentType: 'image/png' });
    expect(seen).toEqual([{ id: 'i', ownerId: 'o', kind: 'thumbstopper', storageKey: 'k', bytes: 5, contentType: 'image/png', campaignId: 'c' }]);
  });
});
