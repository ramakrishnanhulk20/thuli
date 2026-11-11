import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import { z } from 'zod';
import { parseAddress, type Address } from '@thuli/core';

/** Set on 6 Nov. A constant in code, so neither the environment nor a request can change what a screening costs. */
export const PRICE = '$0.05';
/** PRICE in USDC base units (6 decimals). The exact scheme needs the payment to equal this, not exceed it. */
export const PRICE_UNITS = '50000';
export const DEFAULT_PORT = 8787;
export const DEFAULT_TESTNET_FACILITATOR = 'https://x402.org/facilitator';
/** Base Sepolia's public RPC. Base mainnet has no default: BASE_RPC_URL must name one. */
export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

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
  /**
   * The lowercase name of the header the hosting platform writes the client's address into, such as
   * x-vercel-forwarded-for. Null means the socket address is the client, which is right only with no proxy in front.
   */
  trustedClientHeader: string | null;
  /** An https RPC on the payment's own chain, read only to check a settlement the facilitator left pending. */
  settlementRpcUrl: string;
  /**
   * The Postgres that keeps used payments and the limits for every copy of the server. Null keeps them in this
   * process's memory, which is right only for one long-running server. It holds a password, so it is not enumerable:
   * JSON.stringify, console.log and a spread copy of the config never carry it (C40). Read it from the object
   * loadApiConfig returned, because a spread copy does not have it.
   */
  readonly databaseUrl: string | null;
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

// A rule on the name, not a list of the keys we know today, so a key added to the worker later is caught too. It covers
// every name ending in PRIVATE_KEY, in any letter case, whatever the value looks like. It does not catch a key or a seed
// phrase stored under some other name.
const PRIVATE_KEY_NAME = /(^|_)PRIVATE_KEY$/i;

function refusePrivateKeys(env: Env): void {
  const held = Object.keys(env)
    .filter((name) => PRIVATE_KEY_NAME.test(name) && read(env, name) !== undefined)
    .sort();
  if (held.length === 0) return;
  throw new ConfigError(
    `${held.join(', ')} ${held.length === 1 ? 'is' : 'are'} set, and the paid API must hold no private key. Start it with its own env file (.env.api, see .env.api.example), which names no key.`,
  );
}

// A header name as HTTP defines one, so a typo or a pasted value cannot become the identity source.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function trustedClientHeader(env: Env): string | null {
  const value = read(env, 'TRUSTED_CLIENT_HEADER');
  if (value === undefined) return null;
  if (!HEADER_NAME.test(value)) throw new ConfigError('TRUSTED_CLIENT_HEADER must be a header name such as x-vercel-forwarded-for.');
  return value.toLowerCase();
}

const HttpsUrl = z.url({ protocol: /^https$/ });

function facilitatorUrl(env: Env): string {
  const value = read(env, 'FACILITATOR_URL') ?? DEFAULT_TESTNET_FACILITATOR;
  if (!HttpsUrl.safeParse(value).success) throw new ConfigError('FACILITATOR_URL must be an https URL.');
  return value;
}

function settlementRpcUrl(env: Env, network: NetworkName): string {
  if (network === 'base-sepolia') return BASE_SEPOLIA_RPC;
  const value = required(env, 'BASE_RPC_URL');
  if (!HttpsUrl.safeParse(value).success) throw new ConfigError('BASE_RPC_URL must be an https URL.');
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

// The scheme test is the one the store's own connector applies, and the parts it decodes must decode here too, so a URL
// this accepts is one the store can read. The message never holds the value, which carries the password (C40).
function databaseUrl(env: Env): string | null {
  const value = read(env, 'DATABASE_URL');
  if (value === undefined) return null;
  const refusal = new ConfigError('DATABASE_URL must be a postgres:// or postgresql:// URL that names a host. Leave it empty to keep payments in memory.');
  if (!/^postgres(ql)?:\/\//.test(value) || !URL.canParse(value)) throw refusal;
  const url = new URL(value);
  if (url.hostname === '') throw refusal;
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    decodeURIComponent(url.pathname);
  } catch {
    throw refusal;
  }
  return value;
}

function port(env: Env): number {
  const value = read(env, 'PORT');
  if (value === undefined) return DEFAULT_PORT;
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65_535) throw new ConfigError('PORT must be a whole number from 1 to 65535.');
  return Number(value);
}

/**
 * Reads and checks the paid API's settings. X402_NETWORK has no default, so testnet payments are off unless chosen.
 * Base needs PAYTO_ADDRESS, the CDP keys, PUBLIC_ORIGIN and BASE_RPC_URL; Base Sepolia needs PAYTO_ADDRESS_TESTNET,
 * may name a FACILITATOR_URL and a PUBLIC_ORIGIN, and reads its receipts from the public Sepolia RPC.
 * TRUSTED_CLIENT_HEADER and DATABASE_URL are optional on both.
 *
 * Refuses to start while any variable named like a private key is set, because a key held by an internet-facing server
 * is a key an attacker can reach (C39). This runs first, before any other setting is read.
 *
 * @throws ConfigError naming the first missing or bad variable, or every private key variable that is set. The message
 * never holds a value (C40).
 */
export function loadApiConfig(env: Env): ApiConfig {
  refusePrivateKeys(env);
  const network = read(env, 'X402_NETWORK');
  if (network !== 'base' && network !== 'base-sepolia') {
    throw new ConfigError('X402_NETWORK must be base or base-sepolia.');
  }
  const chain = NETWORKS[network];
  const payToName = network === 'base' ? 'PAYTO_ADDRESS' : 'PAYTO_ADDRESS_TESTNET';
  const payTo = addressFrom(env, payToName);

  let facilitator: FacilitatorClient;
  if (network === 'base') {
    facilitator = createCdpFacilitatorClient({
      apiKeyId: required(env, 'CDP_API_KEY_ID'),
      apiKeySecret: required(env, 'CDP_API_KEY_SECRET'),
    });
  } else {
    facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl(env) });
  }

  const settings: Omit<ApiConfig, 'databaseUrl'> = {
    network,
    networkId: chain.id,
    chainId: chain.chainId,
    usdc: parseAddress(chain.usdc),
    explorer: chain.explorer,
    payTo,
    publicOrigin: publicOrigin(env, network === 'base'),
    facilitator,
    port: port(env),
    trustedClientHeader: trustedClientHeader(env),
    settlementRpcUrl: settlementRpcUrl(env, network),
  };
  return Object.defineProperty(settings, 'databaseUrl', { value: databaseUrl(env), enumerable: false }) as ApiConfig;
}
