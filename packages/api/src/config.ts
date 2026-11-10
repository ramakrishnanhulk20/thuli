import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { parseAddress, type Address } from '@thuli/core';

/** Ram set this on 6 Nov. A constant in code, so neither the environment nor a request can change what a screening costs. */
export const PRICE = '$0.05';
/** PRICE in USDC base units (6 decimals). The exact scheme needs the payment to equal this, not exceed it. */
export const PRICE_UNITS = '50000';
export const DEFAULT_PORT = 8787;
export const DEFAULT_TESTNET_FACILITATOR = 'https://x402.org/facilitator';

/** The only two networks the paid route can run on, with each one's canonical USDC contract and explorer. */
export const NETWORKS = Object.freeze({
  base: Object.freeze({
    id: 'eip155:8453',
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorer: 'https://basescan.org',
  }),
  'base-sepolia': Object.freeze({
    id: 'eip155:84532',
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org',
  }),
});

export type NetworkName = keyof typeof NETWORKS;
export type NetworkId = (typeof NETWORKS)[NetworkName]['id'];

export interface ApiConfig {
  network: NetworkName;
  networkId: NetworkId;
  chainId: number;
  usdc: Address;
  explorer: string;
  payTo: Address;
  /**
   * The public https origin the paid route lives at, used for the 402 resource URL and the Bazaar listing, so a client's
   * Host header never shapes them. Null only on Base Sepolia, where the request's own origin is used instead.
   */
  publicOrigin: string | null;
  /** The CDP facilitator on Base, the configured URL on Base Sepolia. Holds the CDP credentials inside, never as fields. */
  facilitator: FacilitatorClient;
  port: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function required(env: Env, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw new ConfigError(`${name} is missing. Set it in .env (see .env.example).`);
  return value;
}

// Every message names the variable and never its value, because a value here may be a key or a secret (C40).
function addressFrom(env: Env, name: string): Address {
  try {
    return parseAddress(required(env, name));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${name} is not a valid address. Use the 0x form with a correct checksum or all lowercase.`);
  }
}

const PrivateKey = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);

function keyAddress(env: Env, name: string): Address | undefined {
  const value = read(env, name);
  if (value === undefined) return undefined;
  const parsed = PrivateKey.safeParse(value);
  // An unreadable key cannot be compared with payTo, so the check below would pass blind. Refuse instead.
  if (!parsed.success) throw new ConfigError(`${name} is set but is not a 32-byte hex private key.`);
  const hex = parsed.data.startsWith('0x') ? parsed.data : `0x${parsed.data}`;
  return parseAddress(privateKeyToAccount(hex as `0x${string}`).address);
}

const HttpsUrl = z.url({ protocol: /^https$/ });

function facilitatorUrl(env: Env): string {
  const value = read(env, 'FACILITATOR_URL') ?? DEFAULT_TESTNET_FACILITATOR;
  if (!HttpsUrl.safeParse(value).success) throw new ConfigError('FACILITATOR_URL must be an https URL.');
  return value;
}

function publicOrigin(env: Env, isRequired: boolean): string | null {
  const value = read(env, 'PUBLIC_ORIGIN');
  if (value === undefined) {
    if (isRequired) throw new ConfigError('PUBLIC_ORIGIN is missing. Base mainnet needs the https origin the API is served at.');
    return null;
  }
  const refusal = new ConfigError('PUBLIC_ORIGIN must be an https origin such as https://api.example.com, with no path.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refusal;
  }
  const bare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  if (url.protocol !== 'https:' || !bare) throw refusal;
  return url.origin;
}

function port(env: Env): number {
  const value = read(env, 'PORT');
  if (value === undefined) return DEFAULT_PORT;
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65_535) throw new ConfigError('PORT must be a whole number from 1 to 65535.');
  return Number(value);
}

/**
 * Reads and checks the paid API's settings. X402_NETWORK has no default, so testnet payments are off unless chosen.
 * Base needs PAYTO_ADDRESS, the CDP keys and PUBLIC_ORIGIN; Base Sepolia needs PAYTO_ADDRESS_TESTNET and may name a
 * FACILITATOR_URL and a PUBLIC_ORIGIN.
 *
 * Refuses to start when payTo is the address of WORKER_PRIVATE_KEY or PAYER_PRIVATE_KEY, because a payTo key held by a
 * server is a key an attacker can reach (C39). A key that is set but unreadable is refused too, rather than skipped.
 *
 * @throws ConfigError naming the first missing or bad variable. The message never holds a value (C40).
 */
export function loadApiConfig(env: Env): ApiConfig {
  const network = read(env, 'X402_NETWORK');
  if (network !== 'base' && network !== 'base-sepolia') {
    throw new ConfigError('X402_NETWORK must be base or base-sepolia.');
  }
  const chain = NETWORKS[network];
  const payToName = network === 'base' ? 'PAYTO_ADDRESS' : 'PAYTO_ADDRESS_TESTNET';
  const payTo = addressFrom(env, payToName);

  for (const keyName of ['WORKER_PRIVATE_KEY', 'PAYER_PRIVATE_KEY']) {
    if (keyAddress(env, keyName) === payTo) {
      throw new ConfigError(
        `${payToName} is the address of ${keyName}. The payTo key must live on no server: use an address from a wallet that stays off this machine's .env.`,
      );
    }
  }

  let facilitator: FacilitatorClient;
  if (network === 'base') {
    facilitator = createCdpFacilitatorClient({
      apiKeyId: required(env, 'CDP_API_KEY_ID'),
      apiKeySecret: required(env, 'CDP_API_KEY_SECRET'),
    });
  } else {
    facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl(env) });
  }

  return {
    network,
    networkId: chain.id,
    chainId: chain.chainId,
    usdc: parseAddress(chain.usdc),
    explorer: chain.explorer,
    payTo,
    publicOrigin: publicOrigin(env, network === 'base'),
    facilitator,
    port: port(env),
  };
}
