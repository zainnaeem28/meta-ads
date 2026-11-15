// ETags from the last successful read of each resource URL, echoed back as If-Match on a write (ADR-010).
const etags = new Map<string, string>();

const keyOf = (url: string): string => {
  try {
    return new URL(url, 'http://local.invalid').pathname;
  } catch {
    return url;
  }
};

export const rememberEtag = (url: string, etag: string | null): void => {
  if (etag) etags.set(keyOf(url), etag);
};

export const storedEtag = (url: string): string | undefined => etags.get(keyOf(url));

export const clearEtags = (): void => etags.clear();

/** Request options carrying `If-Match` for the resource at `url`; empty when no ETag was read yet. */
export const ifMatch = (url: string): { headers?: Record<string, string> } => {
  const etag = storedEtag(url);
  return etag ? { headers: { 'If-Match': etag } } : {};
};
