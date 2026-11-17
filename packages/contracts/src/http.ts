// Fetch mutator for the generated client. Hand-written; the generated client calls this for every request.
export const httpClient = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const base = (globalThis as { __SHROOMAP_API_BASE__?: string }).__SHROOMAP_API_BASE__ ?? '';
  const response = await fetch(`${base}${url}`, { credentials: 'include', ...init });
  const text = await response.text();
  const csv = response.headers.get('Content-Type')?.startsWith('text/csv') ?? false;
  const data: unknown = csv ? text : text.length > 0 ? JSON.parse(text) : undefined;
  return { data, status: response.status, headers: response.headers } as T;
};
