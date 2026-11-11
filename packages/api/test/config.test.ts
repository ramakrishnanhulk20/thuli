// Not covered here: whether the CDP keys are accepted by CDP (no request leaves the machine: fetch is a stand-in), and
// the facilitator's own /supported answer, which the payment middleware checks at start (payment.test.ts uses a stub).
import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { FacilitatorTimeoutError } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayerKeyError, takePayerAccount } from '../scripts/payer-key.ts';
import {
  BASE_SEPOLIA_RPC,
  ConfigError,
  DEFAULT_PORT,
  loadApiConfig,
  SETTLE_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  type ApiConfig,
} from '../src/config.ts';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const WORKER_KEY = generatePrivateKey();
const PAYER_KEY = generatePrivateKey();
const CDP_SECRET = 'cdp-secret-that-must-never-print';
// A key made for this run only, in the form CDP signs with, so the CDP client gets as far as its HTTP call.
const SIGNING_SECRET = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PAYLOAD = { x402Version: 2, accepted: {}, payload: {} } as unknown as PaymentPayload;
const REQUIREMENTS = {} as PaymentRequirements;

/** Stands in for fetch: records each URL asked for, and answers with body, or never when body is null. */
function fetchStandIn(body: unknown) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : String(input));
    if (body === null) return new Promise<never>(() => undefined);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return urls;
}

async function verifyUrl(config: ApiConfig): Promise<string | undefined> {
  const urls = fetchStandIn({ isValid: true, payer: PAY_TO });
  await config.facilitator.verify(PAYLOAD, REQUIREMENTS);
  return urls[0];
}

const testnet = (extra: Record<string, string | undefined> = {}) => ({
  X402_NETWORK: 'base-sepolia',
  PAYTO_ADDRESS_TESTNET: PAY_TO,
  ...extra,
});

const mainnet = (extra: Record<string, string | undefined> = {}) => ({
  X402_NETWORK: 'base',
  PAYTO_ADDRESS: PAY_TO,
  CDP_API_KEY_ID: 'cdp-key-id',
  CDP_API_KEY_SECRET: CDP_SECRET,
  PUBLIC_ORIGIN: 'https://api.thuli.example',
  BASE_RPC_URL: 'https://mainnet.base.org',
  ...extra,
});

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadApiConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadApiConfig', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads Base Sepolia with the public facilitator and the default port', async () => {
    const config = loadApiConfig(testnet());
    expect(config).toMatchObject({
      network: 'base-sepolia',
      networkId: 'eip155:84532',
      chainId: 84532,
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: PAY_TO,
      port: DEFAULT_PORT,
    });
    expect(await verifyUrl(config)).toBe('https://x402.org/facilitator/verify');
  });

  it('reads Base mainnet with the CDP facilitator', async () => {
    const config = loadApiConfig(mainnet({ PORT: '9000' }));
    expect(config).toMatchObject({ network: 'base', networkId: 'eip155:8453', chainId: 8453, port: 9000 });
    expect(config.usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(JSON.stringify(config)).not.toContain(CDP_SECRET);
    expect(inspect(config, { depth: 8 })).not.toContain(CDP_SECRET);
    expect(await verifyUrl(loadApiConfig(mainnet({ CDP_API_KEY_SECRET: SIGNING_SECRET })))).toBe(
      'https://api.cdp.coinbase.com/platform/v2/x402/verify',
    );
  });

  it('bounds every facilitator call on both networks: a hanging verify ends at 15 s and a hanging settle at 30 s, with nothing settled (C41)', async () => {
    expect([VERIFY_TIMEOUT_MS, SETTLE_TIMEOUT_MS]).toEqual([15_000, 30_000]);
    for (const env of [testnet(), mainnet({ CDP_API_KEY_SECRET: SIGNING_SECRET })]) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const urls = fetchStandIn(null);
      const config = loadApiConfig(env);
      for (const [call, limit] of [
        [() => config.facilitator.verify(PAYLOAD, REQUIREMENTS), VERIFY_TIMEOUT_MS],
        [() => config.facilitator.settle(PAYLOAD, REQUIREMENTS), SETTLE_TIMEOUT_MS],
      ] as const) {
        let outcome: unknown = 'waiting';
        void call().then(
          () => (outcome = 'answered'),
          (error: unknown) => (outcome = error),
        );
        await vi.advanceTimersByTimeAsync(limit - 1);
        expect(outcome, env.X402_NETWORK).toBe('waiting');
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome, env.X402_NETWORK).toBeInstanceOf(FacilitatorTimeoutError);
        if (limit === VERIFY_TIMEOUT_MS) expect(urls.some((url) => url.endsWith('/settle')), env.X402_NETWORK).toBe(false);
      }
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('has no default network, so testnet is off unless chosen', () => {
    expect(configError({ PAYTO_ADDRESS_TESTNET: PAY_TO }).message).toContain('X402_NETWORK');
    expect(configError(testnet({ X402_NETWORK: 'base-mainnet' })).message).toContain('X402_NETWORK');
  });

  it('names a missing or bad payTo without printing it', () => {
    expect(configError(testnet({ PAYTO_ADDRESS_TESTNET: undefined })).message).toContain('PAYTO_ADDRESS_TESTNET');
    expect(configError(mainnet({ PAYTO_ADDRESS: '' })).message).toContain('PAYTO_ADDRESS');
    const badChecksum = '0x041F77015fe51c51aE49a7f2F3Ff86C641fa190a';
    const error = configError(testnet({ PAYTO_ADDRESS_TESTNET: badChecksum }));
    expect(error.message).toContain('PAYTO_ADDRESS_TESTNET');
    expect(error.message).not.toContain(badChecksum);
  });

  it('needs both CDP keys on mainnet and never prints them', () => {
    expect(configError(mainnet({ CDP_API_KEY_ID: undefined })).message).toContain('CDP_API_KEY_ID');
    const error = configError(mainnet({ CDP_API_KEY_SECRET: '  ' }));
    expect(error.message).toContain('CDP_API_KEY_SECRET');
  });

  it('refuses to start while any private key is in its environment, naming it and never printing it (C39)', () => {
    const worker = configError(testnet({ WORKER_PRIVATE_KEY: WORKER_KEY }));
    expect(worker.message).toContain('WORKER_PRIVATE_KEY');
    expect(worker.message).not.toContain(WORKER_KEY.slice(2));
    // Checked before the network, so even a half-written env file with a key in it refuses for the key.
    const several = configError({ vault_agent_private_key: 'not-even-hex', PRIVATE_KEY: PAYER_KEY });
    expect(several.message).toContain('PRIVATE_KEY, vault_agent_private_key');
    expect(several.message).not.toContain('not-even-hex');
    expect(several.message).not.toContain(PAYER_KEY.slice(2));
    expect(configError(mainnet({ PAYER_PRIVATE_KEY: PAYER_KEY })).message).toContain('PAYER_PRIVATE_KEY');
    expect(loadApiConfig(testnet({ WORKER_PRIVATE_KEY: '  ', PRIVATE_KEY_PATH: '/keys/x' })).network).toBe('base-sepolia');
  });

  it('says this process must hold no private key, naming the variable but no value and no file, wherever the API runs (C40)', () => {
    const { message } = configError(testnet({ WORKER_PRIVATE_KEY: WORKER_KEY }));
    expect(message).toBe(
      'WORKER_PRIVATE_KEY is set, and this process must hold no private key, because it serves the paid API to the internet. Start it without WORKER_PRIVATE_KEY.',
    );
    expect(message).not.toContain(WORKER_KEY.slice(2));
    expect(message).not.toContain('.env');
    expect(configError(testnet({ PAYER_PRIVATE_KEY: PAYER_KEY, WORKER_PRIVATE_KEY: WORKER_KEY })).message).toMatch(
      /^PAYER_PRIVATE_KEY, WORKER_PRIVATE_KEY are set, and this process must hold no private key/,
    );
  });

  it('takes the payer key out of the environment, so the API started next in the same process sees none (C39)', () => {
    const env: Record<string, string | undefined> = testnet({ PAYER_PRIVATE_KEY: PAYER_KEY.slice(2) });
    expect(configError(env).message).toContain('PAYER_PRIVATE_KEY');
    expect(takePayerAccount(env).address).toBe(privateKeyToAccount(PAYER_KEY).address);
    expect('PAYER_PRIVATE_KEY' in env).toBe(false);
    expect(loadApiConfig(env).network).toBe('base-sepolia');

    const unreadable: Record<string, string | undefined> = { PAYER_PRIVATE_KEY: 'not-a-key' };
    const error = (() => {
      try {
        takePayerAccount(unreadable);
      } catch (caught) {
        return caught;
      }
      throw new Error('expected a PayerKeyError');
    })();
    expect(error).toBeInstanceOf(PayerKeyError);
    expect((error as PayerKeyError).message).toContain('PAYER_PRIVATE_KEY');
    expect((error as PayerKeyError).message).not.toContain('not-a-key');
    expect('PAYER_PRIVATE_KEY' in unreadable).toBe(false);
  });

  it('needs an https PUBLIC_ORIGIN with no path on mainnet, and makes it optional on Base Sepolia', () => {
    expect(loadApiConfig(mainnet({ PUBLIC_ORIGIN: 'https://api.thuli.example/' })).publicOrigin).toBe('https://api.thuli.example');
    expect(configError(mainnet({ PUBLIC_ORIGIN: undefined })).message).toContain('PUBLIC_ORIGIN');
    for (const bad of ['http://api.thuli.example', 'https://api.thuli.example/pay', 'https://user@api.thuli.example', 'thuli']) {
      expect(configError(mainnet({ PUBLIC_ORIGIN: bad })).message).toContain('PUBLIC_ORIGIN');
    }
    expect(loadApiConfig(testnet()).publicOrigin).toBeNull();
    expect(loadApiConfig(testnet({ PUBLIC_ORIGIN: 'https://test.thuli.example' })).publicOrigin).toBe('https://test.thuli.example');
  });

  it('reads pending settlements from BASE_RPC_URL on mainnet, which is required and https, and from the public RPC on Sepolia', () => {
    expect(loadApiConfig(mainnet()).settlementRpcUrl).toBe('https://mainnet.base.org');
    expect(configError(mainnet({ BASE_RPC_URL: undefined })).message).toContain('BASE_RPC_URL');
    expect(configError(mainnet({ BASE_RPC_URL: 'http://mainnet.base.org' })).message).toContain('BASE_RPC_URL');
    expect(loadApiConfig(testnet({ BASE_RPC_URL: 'https://elsewhere.example' })).settlementRpcUrl).toBe(BASE_SEPOLIA_RPC);
  });

  it('reads an optional DATABASE_URL and refuses a malformed one without printing it (C40)', () => {
    const databaseUrl = 'postgresql://thuli:hunter2-db-secret@db.internal.example:5432/thuli';
    expect(loadApiConfig(testnet()).databaseUrl).toBeNull();
    expect(loadApiConfig(testnet({ DATABASE_URL: '  ' })).databaseUrl).toBeNull();
    expect(loadApiConfig(testnet({ DATABASE_URL: databaseUrl })).databaseUrl).toBe(databaseUrl);
    expect(loadApiConfig(mainnet({ DATABASE_URL: 'postgres://thuli@localhost/thuli' })).databaseUrl).toBe('postgres://thuli@localhost/thuli');
    const malformed = [
      'mysql://thuli:hunter2-db-secret@db.internal.example/thuli',
      'postgres:/thuli:hunter2-db-secret@db.internal.example/thuli',
      'postgres://thuli:hunter2-db-secret@/thuli',
      'postgres://thuli:hunter2-db-secret%zz@db.internal.example/thuli',
      'postgres://thuli:hunter2-db-secret@db.internal.example:99999/thuli',
      'thuli:hunter2-db-secret@db.internal.example',
    ];
    for (const value of malformed) {
      const error = configError(testnet({ DATABASE_URL: value }));
      expect(error.message, value).toContain('DATABASE_URL');
      expect(error.message, value).not.toContain('hunter2');
      expect(error.message, value).not.toContain('db.internal.example');
    }
  });

  it('keeps DATABASE_URL out of anything that prints the config, while config.databaseUrl still reads it (C40)', () => {
    const databaseUrl = 'postgres://thuli:hunter2-db-secret@db.internal.example:5432/thuli';
    const config = loadApiConfig(testnet({ DATABASE_URL: databaseUrl }));
    expect(config.databaseUrl).toBe(databaseUrl);
    for (const printed of [JSON.stringify(config), inspect(config, { depth: 5 }), JSON.stringify({ ...config }), Object.keys(config).join()]) {
      expect(printed).not.toContain('hunter2');
      expect(printed).not.toContain('db.internal.example');
      expect(printed).not.toContain('databaseUrl');
    }
  });

  describe('the database address, when a host sets both a pooled and a direct one', () => {
    const pooled = 'postgres://thuli:hunter2-pooled@db-pooler.internal.example/thuli';
    const direct = 'postgres://thuli:hunter2-direct@db.internal.example/thuli';

    it('uses DATABASE_URL_UNPOOLED when it is set, alone or beside DATABASE_URL, and prints neither', () => {
      const both = loadApiConfig(testnet({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct }));
      expect(both.databaseUrl).toBe(direct);
      expect(loadApiConfig(testnet({ DATABASE_URL_UNPOOLED: direct })).databaseUrl).toBe(direct);
      for (const printed of [JSON.stringify(both), inspect(both, { depth: 5 }), Object.keys(both).join()]) {
        expect(printed).not.toContain('hunter2');
      }
    });

    it('still reads DATABASE_URL alone', () => {
      expect(loadApiConfig(testnet({ DATABASE_URL: pooled })).databaseUrl).toBe(pooled);
    });

    it('falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is empty or blank', () => {
      expect(loadApiConfig(testnet({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: '' })).databaseUrl).toBe(pooled);
      expect(loadApiConfig(testnet({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: '   ' })).databaseUrl).toBe(pooled);
    });

    it('refuses a malformed DATABASE_URL_UNPOOLED rather than quietly using DATABASE_URL, naming it and printing neither', () => {
      for (const bad of ['mysql://thuli:hunter2-direct@db.internal.example/thuli', 'postgres://thuli:hunter2-direct@/thuli']) {
        const error = configError(testnet({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: bad }));
        expect(error.message, bad).toContain('DATABASE_URL_UNPOOLED');
        expect(error.message, bad).not.toContain('hunter2');
        expect(error.message, bad).not.toContain('internal.example');
      }
    });
  });

  it('still refuses to start for a private key when a DATABASE_URL is set, and names neither value (C39, C40)', () => {
    const error = configError(testnet({ DATABASE_URL: 'postgres://thuli:hunter2-db-secret@db.internal.example/thuli', WORKER_PRIVATE_KEY: WORKER_KEY }));
    expect(error.message).toContain('WORKER_PRIVATE_KEY');
    expect(error.message).not.toContain(WORKER_KEY.slice(2));
    expect(error.message).not.toContain('hunter2');
  });

  it('refuses a facilitator that is not https and a port out of range', () => {
    expect(configError(testnet({ FACILITATOR_URL: 'http://x402.org/facilitator' })).message).toContain('FACILITATOR_URL');
    expect(configError(testnet({ PORT: '70000' })).message).toContain('PORT');
    expect(configError(testnet({ PORT: '08' })).message).toContain('PORT');
  });
});
