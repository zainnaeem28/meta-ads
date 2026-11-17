import { describe, expect, it } from 'vitest';
import { qcConfigFrom } from '../production.module.js';

describe('qcConfigFrom', () => {
  it('uses the registry defaults', () => {
    expect(qcConfigFrom({})).toEqual({
      transcribeModel: 'gpt-transcribe',
      maxWordErrorRate: 0.2,
      deadlineMinutes: 10,
      idempotencyTtlHours: 24,
      orphanAfterSec: 300,
      requeueAfterSec: 120,
    });
  });

  it('reads the limit and the model, and points the transcription at a stand-in only when given a base URL', () => {
    const config = qcConfigFrom({ QC_MAX_WORD_ERROR_RATE: '0.35', OPENAI_TRANSCRIBE_MODEL: 'whisper-x' }, 'https://api.openai.com:9443');
    expect(config).toMatchObject({ maxWordErrorRate: 0.35, transcribeModel: 'whisper-x', transcribeUrl: 'https://api.openai.com:9443/v1/audio/transcriptions' });
  });

  it.each(['1.5', '-0.1', 'abc'])('stops the process, naming the variable, for QC_MAX_WORD_ERROR_RATE=%s', (value) => {
    expect(() => qcConfigFrom({ QC_MAX_WORD_ERROR_RATE: value })).toThrow('QC_MAX_WORD_ERROR_RATE');
  });
});
