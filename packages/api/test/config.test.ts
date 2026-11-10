// Not covered here: whether the CDP keys are accepted by CDP (no request leaves the machine), and the facilitator's
// own /supported answer, which the payment middleware checks at start (payment.test.ts uses a stub).
import { HTTPFacilitatorClient } from '@x402/core/server';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_PORT, loadApiConfig } from '../src/config.ts';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const WORKER_KEY = generatePrivateKey();
const PAYER_KEY = generatePrivateKey();
const CDP_SECRET = 'cdp-secret-that-must-never-print';

const testnet = (extra: Record<string, string | undefined> = {}) => ({
  X402_NETWORK: 'base-sepolia',
  PAYTO_ADDRESS_TESTNET: PAY_TO,
  WORKER_PRIVATE_KEY: WORKER_KEY,
  PAYER_PRIVATE_KEY: PAYER_KEY,
  ...extra,
});

const mainnet = (extra: Record<string, string | undefined> = {}) => ({
  X402_NETWORK: 'base',
  PAYTO_ADDRESS: PAY_TO,
  CDP_API_KEY_ID: 'cdp-key-id',
  CDP_API_KEY_SECRET: CDP_SECRET,
  PUBLIC_ORIGIN: 'https://api.thuli.example',
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
  it('reads Base Sepolia with the public facilitator and the default port', () => {
    const config = loadApiConfig(testnet());
    expect(config).toMatchObject({
      network: 'base-sepolia',
      networkId: 'eip155:84532',
      chainId: 84532,
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: PAY_TO,
      port: DEFAULT_PORT,
    });
    expect(config.facilitator).toBeInstanceOf(HTTPFacilitatorClient);
    expect((config.facilitator as HTTPFacilitatorClient).url).toBe('https://x402.org/facilitator');
  });

  it('reads Base mainnet with the CDP facilitator', () => {
    const config = loadApiConfig(mainnet({ PORT: '9000' }));
    expect(config).toMatchObject({ network: 'base', networkId: 'eip155:8453', chainId: 8453, port: 9000 });
    expect(config.usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect((config.facilitator as HTTPFacilitatorClient).url).toBe('https://api.cdp.coinbase.com/platform/v2/x402');
    expect(JSON.stringify(config)).not.toContain(CDP_SECRET);
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

  it('refuses a payTo that is the address of a key on this machine (C39)', () => {
    const workerAddress = privateKeyToAccount(WORKER_KEY).address;
    const payerAddress = privateKeyToAccount(PAYER_KEY).address;
    const asWorker = configError(testnet({ PAYTO_ADDRESS_TESTNET: workerAddress.toLowerCase() }));
    expect(asWorker.message).toContain('WORKER_PRIVATE_KEY');
    expect(asWorker.message).not.toContain(WORKER_KEY);
    expect(configError(mainnet({ PAYTO_ADDRESS: payerAddress, PAYER_PRIVATE_KEY: PAYER_KEY.slice(2) })).message).toContain(
      'PAYER_PRIVATE_KEY',
    );
  });

  it('refuses a key it cannot read, because the payTo check would then pass blind', () => {
    const error = configError(testnet({ WORKER_PRIVATE_KEY: 'not-a-key' }));
    expect(error.message).toContain('WORKER_PRIVATE_KEY');
    expect(error.message).not.toContain('not-a-key');
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

  it('refuses a facilitator that is not https and a port out of range', () => {
    expect(configError(testnet({ FACILITATOR_URL: 'http://x402.org/facilitator' })).message).toContain('FACILITATOR_URL');
    expect(configError(testnet({ PORT: '70000' })).message).toContain('PORT');
    expect(configError(testnet({ PORT: '08' })).message).toContain('PORT');
  });
});
