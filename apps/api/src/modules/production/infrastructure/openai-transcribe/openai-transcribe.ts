import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { assertNoEgress } from '../../../../platform/db/index.js';
import { EGRESS, EgressError, classifyEgressFailure, classifyProviderFailure } from '../../../../platform/egress/index.js';
import type { Egress } from '../../../../platform/egress/index.js';
import { QC_CONFIG } from '../../application/qc-ports.js';
import type { QcConfig, Transcript, TranscribePort } from '../../application/qc-ports.js';
import { ProviderCallFailed, ProviderInvalidResponse } from '../../application/worker/ports.js';
import type { ProviderCredential } from '../../application/worker/ports.js';

/** The one fixed endpoint; built here, never from a caller's input. The host is on the egress allow-list. */
export const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const PROVIDER = 'openai';
const PROVIDER_NAME = 'OpenAI';
/** ARCHITECTURE §1.3: 60 s for the whole call. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;
/** A transcript of a 15 s clip is a few hundred bytes; this bounds how much of any answer is read. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function errorCodeOf(body: Buffer): string | undefined {
  try {
    const code = ((JSON.parse(body.toString('utf8')) as unknown) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** A `multipart/form-data` body: plain fields, then the audio as the `file` part. */
export function multipart(boundary: string, fields: Readonly<Record<string, string>>, file: { name: string; type: string; bytes: Buffer }): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/**
 * TranscribePort over OpenAI `/v1/audio/transcriptions` through `platform/egress` (allow-listed host, pinned address, size
 * and time bounds), language `en`, 60 s. A refusal or failure is classified by ARCHITECTURE §5.10 into `ProviderCallFailed`;
 * an answer without a `text` is `ProviderInvalidResponse` (the call was made and is billed). The key, the audio, the
 * transcript and any provider body never reach a log or an error message.
 */
@Injectable()
export class OpenAiTranscribe implements TranscribePort {
  constructor(
    @Inject(EGRESS) private readonly egress: Pick<Egress, 'fetch'>,
    @Inject(QC_CONFIG) private readonly config: Pick<QcConfig, 'transcribeModel' | 'transcribeUrl'>,
  ) {}

  async transcribe(credential: ProviderCredential, audio: Buffer, language: 'en'): Promise<Transcript> {
    assertNoEgress('openai transcription');
    if (!MODEL.test(this.config.transcribeModel)) throw new RangeError('the transcription model name is not acceptable');
    const boundary = `----qc${randomBytes(12).toString('hex')}`;
    const body = multipart(boundary, { model: this.config.transcribeModel, language, response_format: 'json' }, { name: 'clip.wav', type: 'audio/wav', bytes: audio });
    let response: Awaited<ReturnType<Egress['fetch']>>;
    try {
      response = await this.egress.fetch(PROVIDER, {
        url: this.config.transcribeUrl ?? TRANSCRIPTIONS_URL,
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.apiKey.toString('utf8')}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          accept: 'application/json',
        },
        body,
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        contentTypes: ['application/json'],
      });
    } catch (error) {
      const phase = error instanceof EgressError ? error.phase : 'after_send';
      throw new ProviderCallFailed(classifyEgressFailure(PROVIDER_NAME, phase));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderCallFailed(
        classifyProviderFailure(PROVIDER_NAME, { kind: 'http', status: response.status, errorCode: errorCodeOf(response.body) }),
        response.status,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new ProviderInvalidResponse('body is not JSON');
    }
    const text = (json as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') throw new ProviderInvalidResponse('no transcript text');
    return { text };
  }
}
