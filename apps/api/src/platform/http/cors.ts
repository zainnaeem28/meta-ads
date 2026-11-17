/** CORS for the web origin only (ARCHITECTURE 1.8, TD-D40): exact-match list, never `*`, no credentials mode. */
export function corsOptions(webOrigin: string): {
  origin: string[];
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  credentials: false;
} {
  return {
    origin: [webOrigin],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      'X-Request-ID',
    ],
    exposedHeaders: ['X-Request-ID', 'ETag', 'Retry-After', 'Location'],
    credentials: false,
  };
}
