import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  reactStrictMode: true,
  transpilePackages: ['@shroomap/ui'],
};

export default nextConfig;
