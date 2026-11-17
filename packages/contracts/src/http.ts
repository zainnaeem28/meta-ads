// Fetch mutator for the generated client. Hand-written; the generated client calls this for every request.
// Policy (TD-D40): auth is the bearer header, so requests carry no cookies (credentials 'omit'), matching the API's CORS `credentials: false`.
export const httpClient = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const base = (globalThis as { __SHROOMAP_API_BASE__?: string }).__SHROOMAP_API_BASE__ ?? '';
  const response = await fetch(`${base}${url}`, { credentials: 'omit', ...init });
  const text = await response.text();
  const data: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  return { data, status: response.status, headers: response.headers } as T;
};
