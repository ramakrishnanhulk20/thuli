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
  // The API mounted under app/api and the packages it builds on ship TypeScript sources from this workspace.
  transpilePackages: ['@thuli/api', '@thuli/core', '@thuli/store', '@thuli/worker'],
  // The database drivers load from node_modules at run time: pg's native parts and PGlite's WebAssembly do not bundle.
  serverExternalPackages: ['pg', '@electric-sql/pglite'],
  turbopack: {
    rules: {
      // lib/server/thuliApi.ts takes the rulebook and the store's migrations as text, so they travel inside the bundle.
      '*.md': { condition: { query: '?raw' }, type: 'text' },
      '*.sql': { condition: { query: '?raw' }, type: 'text' },
    },
  },
};

export default config;
