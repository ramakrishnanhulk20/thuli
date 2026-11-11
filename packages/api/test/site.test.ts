// Covers what only this package can see of the site entry: that site.d.ts declares exactly what src/site.ts exports,
// and that the store's migrations must be carried in whole. The mount inside Next.js, its refusals and its answers are
// covered in packages/web/test/api.test.ts. Nothing here calls SERV, a chain or a facilitator.
import { describe, expect, it, vi } from 'vitest';
import type * as Declared from '../site.d.ts';
import { siteApi, type SiteApi, type SiteFiles } from '../src/site.ts';

// Compile-time only: either direction failing to assign means the declaration and the source have drifted apart.
const declaredFromReal: typeof Declared.siteApi = siteApi;
const realFromDeclared: typeof siteApi = siteApi as typeof Declared.siteApi;
const filesAgree: [Declared.SiteFiles, SiteFiles] = [{ rulebook: '', migrations: {} }, { rulebook: '', migrations: {} }];
const apiAgree = (api: Declared.SiteApi): SiteApi => api;

const env = {
  X402_NETWORK: 'base-sepolia',
  PAYTO_ADDRESS_TESTNET: '0x2222222222222222222222222222222222222222',
  SERV_API_KEY: 'test-key',
  SERV_GRAPH_ID: 'gr_bc6116b0153f023d',
  SERV_BASE_URL: 'https://serv.invalid',
  ETH_RPC_URL: 'https://rpc.invalid',
  BLOCKSCOUT_ETH_API: 'https://blockscout.invalid/api/v2',
  NODE_ENV: 'test',
};

describe('siteApi', () => {
  it('has the declaration the site compiles against', () => {
    expect([declaredFromReal, realFromDeclared, apiAgree].every((fn) => typeof fn === 'function')).toBe(true);
    expect(filesAgree).toHaveLength(2);
  });

  // Each case opens its own in-process Postgres before it refuses, which takes seconds when the full suite runs.
  it('answers 503 busy and logs why when the migrations it was handed are missing, misnamed or empty', { timeout: 30_000 }, async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handed: Record<string, string>[] = [{}, { '../001_init.sql': 'SELECT 1;' }, { '001_init.sql': '  \n' }];
    for (const migrations of handed) {
      const api = siteApi(env, { rulebook: 'rules', migrations });
      const reply = await api.fetch(new Request('http://thuli.test/api/check/health'));
      expect(reply.status).toBe(503);
      expect(await reply.json()).toEqual({ busy: true });
      expect(reply.headers.get('cache-control')).toBe('no-store');
    }
    expect(JSON.stringify(error.mock.calls)).toContain('api store did not start');
    error.mockRestore();
    warn.mockRestore();
  });
});
