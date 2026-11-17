import type { BillableCall } from './types.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Defaults the configuration registry gives the models that have one (ARCHITECTURE §6). */
const DEFAULT_MODELS = {
  WAVESPEED_MODEL_I2V: 'bytedance/seedance-2.0/image-to-video',
  WAVESPEED_MODEL_T2V: 'bytedance/seedance-2.0/text-to-video',
  OPENAI_TRANSCRIBE_MODEL: 'gpt-transcribe',
} as const;

/** Vendor assembly is billable only when the vendor adapter is chosen; FFmpeg assembly is free. */
export const ASSEMBLY_VENDOR_OPERATION = 'shotstack-render';

function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * Every billable provider operation this process is configured for (TD-D39): one per configured model, plus the vendor
 * render when that adapter is chosen. The image model is the one operation behind both image analysis output and the
 * thumbstopper images, so one row prices both. A model the process is not given (the api carries no worker-only key)
 * is not listed; the same operation is then checked by the process that has it. A model left to its registry default
 * is listed only with `includeDefaults` (the file validator): a process checks what its environment names.
 */
export function configuredOperations(env: Env, includeDefaults = false): BillableCall[] {
  const calls: BillableCall[] = [];
  const fallback = (name: keyof typeof DEFAULT_MODELS): string | undefined =>
    includeDefaults ? DEFAULT_MODELS[name] : undefined;
  const add = (provider: BillableCall['provider'], operation: string | undefined): void => {
    if (operation === undefined) return;
    if (!calls.some((c) => c.provider === provider && c.operation === operation)) {
      calls.push({ provider, operation });
    }
  };
  add('openai', value(env, 'OPENAI_TEXT_MODEL'));
  add('openai', value(env, 'OPENAI_VISION_MODEL'));
  add('openai', value(env, 'OPENAI_TRANSCRIBE_MODEL') ?? fallback('OPENAI_TRANSCRIBE_MODEL'));
  add('openai', value(env, 'OPENAI_IMAGE_MODEL'));
  add('wavespeed', value(env, 'WAVESPEED_MODEL_I2V') ?? fallback('WAVESPEED_MODEL_I2V'));
  add('wavespeed', value(env, 'WAVESPEED_MODEL_T2V') ?? fallback('WAVESPEED_MODEL_T2V'));
  if (value(env, 'ASSEMBLY_ADAPTER') === 'shotstack')
    add('assembly_vendor', ASSEMBLY_VENDOR_OPERATION);
  return calls;
}
