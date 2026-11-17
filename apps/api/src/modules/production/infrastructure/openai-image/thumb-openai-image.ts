import { Inject, Injectable } from '@nestjs/common';
import { assertNoEgress } from '../../../../platform/db/index.js';
import {
  EGRESS,
  EgressError,
  classifyEgressFailure,
  classifyProviderFailure,
} from '../../../../platform/egress/index.js';
import type { Egress } from '../../../../platform/egress/index.js';
import { THUMB_CONFIG } from '../../application/thumb-ports.js';
import type { GeneratedImage, ImageGenPort, ThumbConfig } from '../../application/thumb-ports.js';
import { ProviderCallFailed, ProviderInvalidResponse } from '../../application/worker/ports.js';
import type { ProviderCredential } from '../../application/worker/ports.js';

/** The one fixed endpoint; built here, never from a caller's input. The host is on the egress allow-list. */
export const IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const PROVIDER = 'openai';
const PROVIDER_NAME = 'OpenAI';
/** ARCHITECTURE §1.3: 120 s for the whole call. */
export const IMAGE_TIMEOUT_MS = 120_000;
/** The image comes back base64 in JSON: this bounds how much of any answer is read. */
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** 9:16 portrait, the shape of the video the image opens. */
const SIZE = '1024x1536';

function errorCodeOf(body: Buffer): string | undefined {
  try {
    const code = (JSON.parse(body.toString('utf8')) as { error?: { code?: unknown } } | null)?.error
      ?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The type of an image from its first bytes, never from what the provider claims. Only PNG, JPEG and WebP are stored. */
export function sniffImage(
  bytes: Buffer,
): Pick<GeneratedImage, 'contentType' | 'extension'> | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { contentType: 'image/jpeg', extension: 'jpg' };
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * ImageGenPort over OpenAI `/v1/images/generations` through `platform/egress` (allow-listed host, pinned address, size and
 * time bounds), one portrait image, 120 s. A refusal or failure is classified by ARCHITECTURE §5.10 into
 * `ProviderCallFailed`; an answer with no image, an image that is too large or one that is not a PNG, JPEG or WebP is
 * `ProviderInvalidResponse` (the call was made and is billed). The key, the prompt, the image and any provider body never
 * reach a log or an error message.
 */
@Injectable()
export class OpenAiImageGen implements ImageGenPort {
  constructor(
    @Inject(EGRESS) private readonly egress: Pick<Egress, 'fetch'>,
    @Inject(THUMB_CONFIG)
    private readonly config: Pick<ThumbConfig, 'imageModel' | 'imageUrl' | 'outputMaxBytes'>,
  ) {}

  async generate(
    credential: ProviderCredential,
    input: { readonly prompt: string },
  ): Promise<GeneratedImage> {
    assertNoEgress('openai image generation');
    const model = this.config.imageModel;
    if (model === undefined || !MODEL.test(model))
      throw new RangeError('the image model name is not acceptable');
    let response: Awaited<ReturnType<Egress['fetch']>>;
    try {
      response = await this.egress.fetch(PROVIDER, {
        url: this.config.imageUrl ?? IMAGES_URL,
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.apiKey.toString('utf8')}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: Buffer.from(JSON.stringify({ model, prompt: input.prompt, n: 1, size: SIZE })),
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs: IMAGE_TIMEOUT_MS,
        contentTypes: ['application/json'],
      });
    } catch (error) {
      const phase = error instanceof EgressError ? error.phase : 'after_send';
      throw new ProviderCallFailed(classifyEgressFailure(PROVIDER_NAME, phase));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderCallFailed(
        classifyProviderFailure(PROVIDER_NAME, {
          kind: 'http',
          status: response.status,
          errorCode: errorCodeOf(response.body),
        }),
        response.status,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new ProviderInvalidResponse('body is not JSON');
    }
    const encoded = (json as { data?: { b64_json?: unknown }[] } | null)?.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || encoded === '' || !BASE64.test(encoded))
      throw new ProviderInvalidResponse('no image data');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > this.config.outputMaxBytes)
      throw new ProviderInvalidResponse('image is too large');
    const type = sniffImage(bytes);
    if (type === null) throw new ProviderInvalidResponse('image is not a PNG, JPEG or WebP');
    return { bytes, ...type };
  }
}
