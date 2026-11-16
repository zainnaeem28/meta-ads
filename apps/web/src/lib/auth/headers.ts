/** Headers every response carries (SECURITY-DESIGN §5, §11.2): no referrer leaves the origin, and nothing is indexed. */
export const SECURITY_HEADERS = {
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

export function withSecurityHeaders<T extends { headers: Headers }>(response: T): T {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}
