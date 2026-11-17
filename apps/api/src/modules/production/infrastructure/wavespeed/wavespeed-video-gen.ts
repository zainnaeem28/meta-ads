import { Inject, Injectable } from '@nestjs/common';
import { assertNoEgress } from '../../../../platform/db/index.js';
import {
  EGRESS,
  EgressError,
  classifyEgressFailure,
  classifyProviderFailure,
} from '../../../../platform/egress/index.js';
import type { Egress } from '../../../../platform/egress/index.js';
import {
  ProviderCallFailed,
  ProviderInvalidResponse,
  VIDEO_WORKER_CONFIG,
} from '../../application/worker/ports.js';
import type {
  ProviderCredential,
  VideoGenPort,
  VideoStatus,
  VideoSubmitInput,
  VideoWorkerConfig,
} from '../../application/worker/ports.js';

/** The one fixed origin; built here, never from a caller's input. The host is on the egress allow-list. */
export const WAVESPEED_BASE_URL = 'https://api.wavespeed.ai';
const PROVIDER = 'wavespeed';
const PROVIDER_NAME = 'WaveSpeed';
/** Every answer of these three calls is a small JSON document; this bounds how much is read. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,3}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AUTH_ERROR =
  /(unauthori[sz]ed|invalid[\s_-]*(api[\s_-]*)?key|api[\s_-]*key|forbidden|permission)/i;

interface Answer {
  readonly status: number;
  readonly json: unknown;
}

/** The answer as JSON, or `undefined` when it is not (a gateway page, an empty body). */
function parsed(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/**
 * VideoGenPort over WaveSpeed's v3 API through `platform/egress` (allow-listed host, pinned address, size and time
 * bounds). `submit` posts `/api/v3/{model}` once and returns the task id; `status` reads
 * `/api/v3/predictions/{id}/result`; `deleteTask` posts `/api/v3/predictions/delete`. A refusal or failure is classified
 * by ARCHITECTURE §5.10 into `ProviderCallFailed`. The key, the request and any provider body never reach a log or an
 * error message, and the output URL is returned to the caller only (VERIFY the exact paths and fields against the live
 * API in stack validation; this adapter is exercised against a local stand-in only).
 */
@Injectable()
export class WaveSpeedVideoGen implements VideoGenPort {
  constructor(
    @Inject(EGRESS) private readonly egress: Pick<Egress, 'fetch'>,
    @Inject(VIDEO_WORKER_CONFIG) private readonly config: Pick<VideoWorkerConfig, 'baseUrl'>,
  ) {}

  async submit(credential: ProviderCredential, input: VideoSubmitInput): Promise<string> {
    if (!MODEL.test(input.model)) throw new RangeError('the video model name is not acceptable');
    const body: Record<string, unknown> = {
      prompt: input.prompt,
      duration: input.durationSeconds,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
    };
    if (input.imageUrl !== null) body['image'] = input.imageUrl;
    const answer = await this.call(
      credential,
      'POST',
      `/api/v3/${input.model}`,
      JSON.stringify(body),
    );
    const id = field(field(answer.json, 'data'), 'id');
    // The request was accepted; an answer without a task id is billed and unusable, so the outcome is unknown.
    if (typeof id !== 'string' || !TASK_ID.test(id)) {
      throw new ProviderCallFailed(
        classifyProviderFailure(PROVIDER_NAME, { kind: 'transport', phase: 'after_send' }),
        answer.status,
      );
    }
    return id;
  }

  async status(credential: ProviderCredential, taskId: string): Promise<VideoStatus> {
    const answer = await this.call(
      credential,
      'GET',
      `/api/v3/predictions/${this.task(taskId)}/result`,
    );
    const data = field(answer.json, 'data');
    const state = field(data, 'status');
    if (state === 'completed') {
      const outputs = field(data, 'outputs');
      const url = Array.isArray(outputs) ? (outputs as unknown[])[0] : undefined;
      if (typeof url !== 'string' || url === '')
        throw new ProviderInvalidResponse('a finished task has no output');
      return { state: 'completed', outputUrl: url };
    }
    if (state === 'failed') {
      const text = field(data, 'error');
      return {
        state: 'failed',
        errorClass: typeof text === 'string' && AUTH_ERROR.test(text) ? 'auth' : 'other',
      };
    }
    if (state === 'created' || state === 'processing') return { state };
    throw new ProviderInvalidResponse('unknown task state');
  }

  async deleteTask(credential: ProviderCredential, taskId: string): Promise<void> {
    await this.call(
      credential,
      'POST',
      '/api/v3/predictions/delete',
      JSON.stringify({ ids: [this.task(taskId)] }),
    );
  }

  private task(taskId: string): string {
    if (!TASK_ID.test(taskId)) throw new RangeError('the task id is not acceptable');
    return taskId;
  }

  private async call(
    credential: ProviderCredential,
    method: 'GET' | 'POST',
    path: string,
    body?: string,
  ): Promise<Answer> {
    assertNoEgress('wavespeed call');
    let response: Awaited<ReturnType<Egress['fetch']>>;
    try {
      response = await this.egress.fetch(PROVIDER, {
        url: `${this.config.baseUrl ?? WAVESPEED_BASE_URL}${path}`,
        method,
        headers: {
          authorization: `Bearer ${credential.apiKey.toString('utf8')}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
        maxBytes: MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      // An egress refusal or failure: before the request left, nothing was sent; after, the outcome is unknown.
      if (error instanceof EgressError)
        throw new ProviderCallFailed(classifyEgressFailure(PROVIDER_NAME, error.phase));
      throw new ProviderCallFailed(classifyEgressFailure(PROVIDER_NAME, 'after_send'));
    }
    const json = parsed(response.body);
    if (response.status >= 200 && response.status < 300) {
      // WaveSpeed also reports a refusal in the body's `code` of a 200 answer; the transport status is the authority first.
      const code = field(json, 'code');
      if (typeof code !== 'number' || code === 200) return { status: response.status, json };
      throw this.refusal(code, json);
    }
    throw this.refusal(response.status, json);
  }

  private refusal(status: number, json: unknown): ProviderCallFailed {
    const message = field(json, 'message');
    const credit =
      typeof message === 'string' && /insufficient[\s_-]*(balance|credit|funds)/i.test(message);
    const classification = classifyProviderFailure(PROVIDER_NAME, {
      kind: 'http',
      status,
      ...(credit ? { errorCode: 'insufficient_balance' } : {}),
    });
    return new ProviderCallFailed(classification, status);
  }
}
