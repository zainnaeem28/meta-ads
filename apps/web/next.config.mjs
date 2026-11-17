import { fileURLToPath } from 'node:url';
import { STATIC_SECURITY_HEADERS } from './src/lib/security/static-headers.mjs';

/** The paths the middleware does not run on (its matcher): build output and the static brand files. */
const UNGUARDED =
  '/:path((?:_next/static|_next/image|favicon|apple-touch-icon|icon-|site\\.webmanifest|social-preview).*)';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@shroomap/ui'],
  // Responses the middleware answers carry the full set (policy with a per-request nonce included); these do not pass it.
  async headers() {
    return [
      {
        source: UNGUARDED,
        headers: Object.entries(STATIC_SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;
