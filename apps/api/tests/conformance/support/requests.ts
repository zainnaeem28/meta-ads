import { randomBytes, randomUUID } from 'node:crypto';
import type { Operation, Params, RequestSpec } from './spec.js';
import { urlFor } from './spec.js';

// A well-formed request for an operation: ids are fresh UUIDs unless the caller names them, bodies and headers satisfy the
// contract's schema. A cell changes exactly the part it is about (the token, one id, one field).

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a52e5ad90000000049454e44ae426082', 'hex');

/** A key shape both provider formats accept (the stack's probe stand-in answers 200). */
export const FAKE_KEY = ['sk', 'conformance', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('-');

/** A key shape the wavespeed format accepts. */
export const WAVE_KEY = 'wavecanary_conf_0123456789abcdefghij';

const BODIES: Readonly<Record<string, () => unknown>> = {
  'API-002': () => ({}),
  'API-011': () => ({ apiKey: FAKE_KEY }),
  'API-021': () => ({ productName: 'Conformance Cap' }),
  'API-023': () => ({ productName: 'Conformance Cap two' }),
  'API-051': () => ({ segments: [{ position: 1, dialogue: 'A calm morning line.' }] }),
  'API-054': () => ({ reason: 'checked by the owner' }),
  'API-060': () => ({}),
  'API-070': () => ({ clips: [randomUUID()] }),
  'API-075': () => ({ calloutText: 'Fresh start' }),
  'API-103': () => ({ confirmation: 'someone@example.test' }),
  'API-104': () => ({ role: 'admin' }),
  'API-111': () => ({ email: `invitee${randomBytes(3).toString('hex')}@example.test` }),
  'API-121': () => ({ mode: 'invited_only' }),
};

export const multipart = (file: Buffer, name = 'file'): { payload: Buffer; headers: Record<string, string> } => {
  const boundary = `----conf${randomBytes(6).toString('hex')}`;
  const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { payload: Buffer.concat([pre, file, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
};

export const PNG_BYTES = PNG;

export function validRequest(op: Operation, params: Params = {}, version = 1): RequestSpec & { raw?: Buffer } {
  const headers: Record<string, string> = {};
  if (op.jobCreating) headers['idempotency-key'] = `conf-${randomBytes(8).toString('hex')}`;
  if (op.ifMatch) headers['if-match'] = `"${String(version)}"`;
  if (op.id === 'API-030') {
    const form = multipart(PNG);
    return { method: op.method, url: urlFor(op, params), headers: { ...headers, ...form.headers }, raw: form.payload };
  }
  const body = BODIES[op.id];
  return { method: op.method, url: urlFor(op, params), headers, ...(body === undefined ? {} : { payload: body() }) };
}
