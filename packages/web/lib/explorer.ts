// The only file that names an explorer host. test/explorer.test.ts reads the site's sources and fails if another file does,
// so moving the site to another explorer is a change to the constants here and nowhere else.

const TX_HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
// Any letter case, and the prefix as a capital X too, for the helpers that normalise what they are given.
const ANY_TX_HASH = /^0[xX][0-9a-fA-F]{64}$/;
const ANY_ADDRESS = /^0[xX][0-9a-fA-F]{40}$/;

export const ETHEREUM_CHAIN = 1;
export const BASE_SEPOLIA_CHAIN = 84532;
export const BASE_CHAIN = 8453;

/** The Basescan address packages/contracts/deployments/base-sepolia-proof.json names. Every Base Sepolia link starts with it. */
export const BASE_SEPOLIA_EXPLORER = 'https://sepolia.basescan.org';

/** The page that shows a contract's verified source. Only links whose text promises the source use it. */
export const VERIFIED_SOURCE_BASE = 'https://base-sepolia.blockscout.com';

const EXPLORERS = new Map<number, string>([
  [ETHEREUM_CHAIN, 'https://etherscan.io'],
  [BASE_SEPOLIA_CHAIN, BASE_SEPOLIA_EXPLORER],
  [BASE_CHAIN, 'https://basescan.org'],
]);

/** The explorer a chain's addresses and transactions are read on, or null for a chain Thuli has no explorer for. */
export function explorerBase(chain: number): string | null {
  return EXPLORERS.get(chain) ?? null;
}

function normalisedAddress(address: unknown): string {
  if (typeof address !== 'string' || !ANY_ADDRESS.test(address)) throw new RangeError('not an address: 0x and 40 hex characters');
  return `0x${address.slice(2).toLowerCase()}`;
}

function normalisedHash(hash: unknown): string {
  if (typeof hash !== 'string' || !ANY_TX_HASH.test(hash)) throw new RangeError('not a transaction hash: 0x and 64 hex characters');
  return `0x${hash.slice(2).toLowerCase()}`;
}

function baseFor(chain: number): string {
  const base = explorerBase(chain);
  if (base === null) throw new RangeError(`no explorer is known for chain ${chain}`);
  return base;
}

/**
 * The explorer page of an address on a chain. The address may be in any letter case, and the link always carries it in
 * lower case.
 *
 * @throws RangeError for text that is not an address, or a chain with no explorer.
 */
export function explorerAddressUrl(chain: number, address: string): string {
  const base = baseFor(chain);
  return `${base}/address/${normalisedAddress(address)}`;
}

/**
 * The explorer page of a transaction on a chain, from a hash in any letter case.
 *
 * @throws RangeError for text that is not a hash, or a chain with no explorer.
 */
export function explorerTxUrl(chain: number, hash: string): string {
  const base = baseFor(chain);
  return `${base}/tx/${normalisedHash(hash)}`;
}

/** The same link as explorerAddressUrl, or null where that would throw. For values that came from outside the site. */
export function addressLink(chain: number, address: string): string | null {
  try {
    return explorerAddressUrl(chain, address);
  } catch {
    return null;
  }
}

export function txLink(chain: number, hash: string): string | null {
  try {
    return explorerTxUrl(chain, hash);
  } catch {
    return null;
  }
}

/**
 * The verified-source page of a contract on Base Sepolia.
 *
 * @throws RangeError for text that is not an address.
 */
export function verifiedSourceUrl(address: string): string {
  return `${VERIFIED_SOURCE_BASE}/address/${normalisedAddress(address)}`;
}

// The two helpers below are the Ethereum history links: wallets and transactions Thuli read on Ethereum, which no Base
// explorer knows. They keep their strict reading, a lowercase 0x and exact length, and give no link for anything else.
const ETHEREUM_EXPLORER = explorerBase(ETHEREUM_CHAIN) as string;

/** A link only for a lowercase 0x and 64 hex characters. Anything else gets no link at all. */
export function txUrl(hash: string): string | null {
  return TX_HASH.test(hash) ? `${ETHEREUM_EXPLORER}/tx/${hash}` : null;
}

/** A link only for a lowercase 0x and 40 hex characters. Anything else gets no link at all. */
export function addressUrl(address: string): string | null {
  return ADDRESS.test(address) ? `${ETHEREUM_EXPLORER}/address/${address}` : null;
}

export function isReplayAddress(value: string): boolean {
  return ADDRESS.test(value);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}
