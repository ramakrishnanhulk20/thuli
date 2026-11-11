import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // A verification build must never share the folder the running dev server uses.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  outputFileTracingRoot: path.join(here, '..', '..'),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
