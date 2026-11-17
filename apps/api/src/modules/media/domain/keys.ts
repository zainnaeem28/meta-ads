// Storage keys (ARCHITECTURE §2.2, §9.3). Built only here, only from server-side identifiers: a client-supplied name
// or path never reaches a key. Prefixes `q/` (quarantine until sanitized), `u/` (user media) and `smoke/` (deployment smoke).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSION = /^[a-z0-9]{1,5}$/;

export const GENERATED_KINDS = ['clip', 'final', 'thumbstopper'] as const;
export type GeneratedKind = (typeof GENERATED_KINDS)[number];

function uuid(name: string, value: string): string {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a lower-case UUID`);
  return value;
}

/** An upload before sanitizing. */
export function quarantineKey(ownerId: string, mediaId: string): string {
  return `q/${uuid('ownerId', ownerId)}/${uuid('mediaId', mediaId)}`;
}

/** A sanitized upload. */
export function uploadKey(ownerId: string, mediaId: string): string {
  return `u/${uuid('ownerId', ownerId)}/media/${uuid('mediaId', mediaId)}`;
}

/** A generated clip, final video or thumbstopper of a campaign. */
export function campaignKey(
  ownerId: string,
  campaignId: string,
  kind: GeneratedKind,
  mediaId: string,
  extension: string,
): string {
  if (!GENERATED_KINDS.includes(kind)) throw new TypeError('kind is not a generated kind');
  if (!EXTENSION.test(extension))
    throw new TypeError('extension must be 1-5 lower-case letters or digits');
  return `u/${uuid('ownerId', ownerId)}/c/${uuid('campaignId', campaignId)}/${kind}/${uuid('mediaId', mediaId)}.${extension}`;
}

/** Deployment smoke objects (put, presign, get, delete). */
export function smokeKey(id: string): string {
  return `smoke/${uuid('id', id)}`;
}

/** Every key of an owner, for erasure. */
export function ownerPrefixes(ownerId: string): readonly string[] {
  const owner = uuid('ownerId', ownerId);
  return [`q/${owner}/`, `u/${owner}/`];
}

/** True when `key` lies under one of the owner's prefixes. */
export function isOwnedKey(ownerId: string, key: string): boolean {
  return UUID.test(ownerId) && ownerPrefixes(ownerId).some((prefix) => key.startsWith(prefix));
}
