import { createPublicKey } from 'node:crypto';
import { z } from 'zod';

// Value parsers for the environment, where every value arrives as a string. Messages are never read back
// (the startup report names only the key), so the parsers stay plain.

export const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

export const decimal = (min: number, max = Number.MAX_VALUE, minExclusive = false) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .transform(Number)
    .pipe(z.number().finite().min(min).max(max))
    .refine((n) => !minExclusive || n > min);

export const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const nonEmpty = z.string().min(1);

export const pathSafe = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/)
  .refine((v) => !v.includes('..'));

export const email = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

export const urlOf = (...protocols: string[]) =>
  z.string().refine((v) => {
    const url = parseUrl(v);
    return url !== undefined && protocols.includes(url.protocol);
  });

export const anyUrl = urlOf('http:', 'https:');
export const httpsUrl = urlOf('https:');
export const postgresUrl = urlOf('postgres:', 'postgresql:');

export const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0),
);

export const domainList = csv.refine((items) =>
  items.every((item) =>
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(item),
  ),
);

const jsonValue = z.string().transform((raw, ctx) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'json' });
    return z.NEVER;
  }
});

const versionKey = z.string().regex(/^[1-9]\d*$/);

/** JSON map `{version: value}` with positive integer versions and a per-value check. */
export const versionedMap = (value: z.ZodType<string>) =>
  jsonValue.pipe(z.record(versionKey, value).refine((m) => Object.keys(m).length > 0));

const isRsa3072PublicKey = (pem: string): boolean => {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails?.modulusLength === 3072;
  } catch {
    return false;
  }
};

export const rsaPublicPem = z.string().refine(isRsa3072PublicKey);
export const privatePem = z
  .string()
  .regex(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/);

export const base64Min32 = z
  .string()
  .refine((v) => /^[A-Za-z0-9+/_-]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length >= 32);

/** At least 32 random bytes as text: 32+ raw characters or a base64url string of 43+ characters. */
export const secretMin32 = z.string().min(32);

export const anchoredRegex = z.string().refine((v) => {
  if (!v.startsWith('^') || !v.endsWith('$')) return false;
  try {
    new RegExp(v);
    return true;
  } catch {
    return false;
  }
});

export const hostEntry = z
  .string()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i);

export const egressHosts = jsonValue.pipe(z.record(z.string().min(1), z.array(hostEntry).min(1)));

const pinoLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const logLevel = z.enum(pinoLevels);
