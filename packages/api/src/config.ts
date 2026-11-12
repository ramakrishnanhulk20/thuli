import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { FacilitatorTimeoutError, HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import { z } from 'zod';
import { parseAddress, type Address } from '@thuli/core';

/**
 * The longest a paid request may run, counted from its first line (C41). The site's host ends a request at 300 s
 * whatever it is doing, so this leaves a minute before that.
 */
export const REQUEST_DEADLINE_MS = 240_000;
/** The longest one facilitator verify call may take before it counts as failed (C41). */
export const VERIFY_TIMEOUT_MS = 15_000;
/**
 * The longest one facilitator settle call, or the one supported-kinds call a copy makes at start, may take (C41). A
 * pending settle is asked once more, so settling waits at most twice this.
 */
export const SETTLE_TIMEOUT_MS = 30_000;

function bounded<T>(operation: string, ms: number, call: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FacilitatorTimeoutError(operation, ms)), ms);
    Promise.resolve()
      .then(call)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/**
 * client with every call bounded: a call that has not answered in time rejects with FacilitatorTimeoutError, which the
 * paid route treats as an outcome it does not know. Set per call here because the library's client takes one timeout
 * for every call and the CDP client takes none. A call cut off here may still finish at the facilitator; the route's
 * claim, kept unsure, is what makes that safe.
 */
export function timedFacilitator(client: FacilitatorClient): FacilitatorClient {
  return {
    getSupported: () => bounded('supported', SETTLE_TIMEOUT_MS, () => client.getSupported()),
    verify: (payload, requirements) => bounded('verify', VERIFY_TIMEOUT_MS, () => client.verify(payload, requirements)),
    settle: (payload, requirements) => bounded('settle', SETTLE_TIMEOUT_MS, () => client.settle(payload, requirements)),
  };
}

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
   * Host header never shapes them. PUBLIC_ORIGIN, or else the production host Vercel names. Null only on Base Sepolia
   * with neither set, where the request's own origin is used instead.
   */
  publicOrigin: string | null;
  /**
   * The CDP facilitator on Base, the configured URL on Base Sepolia, with every call bounded by timedFacilitator. Holds
   * the CDP credentials inside, never as fields.
   */
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
  // Names no file: the API runs on its own and inside the site, and each starts from a different environment.
  const names = held.join(', ');
  throw new ConfigError(
    `${names} ${held.length === 1 ? 'is' : 'are'} set, and this process must hold no private key, because it serves the paid API to the internet. Start it without ${names}.`,
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

// Vercel sets this on every deployment, at build and at run time, to the project's production host with no scheme. The
// platform writes it and no caller can, so it is as safe a source as PUBLIC_ORIGIN, which still wins when both are set.
const VERCEL_PRODUCTION_HOST = 'VERCEL_PROJECT_PRODUCTION_URL';

function publicOrigin(env: Env, isRequired: boolean): string | null {
  const own = read(env, 'PUBLIC_ORIGIN');
  const host = read(env, VERCEL_PRODUCTION_HOST);
  if (own === undefined && host === undefined) {
    if (isRequired) throw new ConfigError('PUBLIC_ORIGIN is missing. Base mainnet needs the https origin the API is served at.');
    return null;
  }
  // A PUBLIC_ORIGIN that is set and bad is refused, never swapped for the host, and both go through the one parser below.
  const refusal =
    own !== undefined
      ? new ConfigError('PUBLIC_ORIGIN must be an https origin such as https://api.example.com, with no path.')
      : new ConfigError(`${VERCEL_PRODUCTION_HOST} must be a bare host name such as thuli.vercel.app. Set PUBLIC_ORIGIN to name the origin yourself.`);
  let url: URL;
  try {
    url = new URL(own ?? `https://${host}`);
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
  // A pooled address refuses the statement timeout the store sets at connect and the session lock it takes to migrate,
  // so a host's direct address, when it supplies one, wins; a bad one is refused, never swapped for the pooled one.
  const name = read(env, 'DATABASE_URL_UNPOOLED') === undefined ? 'DATABASE_URL' : 'DATABASE_URL_UNPOOLED';
  const value = read(env, name);
  if (value === undefined) return null;
  const refusal = new ConfigError(`${name} must be a postgres:// or postgresql:// URL that names a host. Leave it empty to keep payments in memory.`);
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
 * Base needs PAYTO_ADDRESS, the CDP keys, BASE_RPC_URL and its own origin (PUBLIC_ORIGIN, or on Vercel the production
 * host the platform names); Base Sepolia needs PAYTO_ADDRESS_TESTNET, may name a FACILITATOR_URL and a PUBLIC_ORIGIN,
 * and reads its receipts from the public Sepolia RPC.
 * TRUSTED_CLIENT_HEADER and DATABASE_URL are optional on both; DATABASE_URL_UNPOOLED, when set, is used instead of
 * DATABASE_URL.
 *
 * Refuses to start while any variable named like a private key is set, because a key held by an internet-facing server
 * is a key an attacker can reach (C39). This runs first, before any other setting is read.
 *
 * A process that serves nobody but itself, such as the proof script, has no public origin to name, so it may pass
 * publicOrigin 'optional'. One that is set is still checked. Every server leaves the option out.
 *
 * @throws ConfigError naming the first missing or bad variable, or every private key variable that is set. The message
 * never holds a value (C40).
 */
export function loadApiConfig(env: Env, options: { publicOrigin?: 'optional' } = {}): ApiConfig {
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
    // Its own timeout cuts the HTTP request too, so a call bounded below does not keep a connection open for long.
    facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl(env), timeoutMs: SETTLE_TIMEOUT_MS });
  }
  facilitator = timedFacilitator(facilitator);

  const settings: Omit<ApiConfig, 'databaseUrl'> = {
    network,
    networkId: chain.id,
    chainId: chain.chainId,
    usdc: parseAddress(chain.usdc),
    explorer: chain.explorer,
    payTo,
    publicOrigin: publicOrigin(env, network === 'base' && options.publicOrigin !== 'optional'),
    facilitator,
    port: port(env),
    trustedClientHeader: trustedClientHeader(env),
    settlementRpcUrl: settlementRpcUrl(env, network),
  };
  return Object.defineProperty(settings, 'databaseUrl', { value: databaseUrl(env), enumerable: false }) as ApiConfig;
}
