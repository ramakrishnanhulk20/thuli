const TX_HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

const EXPLORER_ROOT = 'https://etherscan.io';

/** A link only for a lowercase 0x and 64 hex characters. Anything else gets no link at all. */
export function txUrl(hash: string): string | null {
  return TX_HASH.test(hash) ? `${EXPLORER_ROOT}/tx/${hash}` : null;
}

/** A link only for a lowercase 0x and 40 hex characters. Anything else gets no link at all. */
export function addressUrl(address: string): string | null {
  return ADDRESS.test(address) ? `${EXPLORER_ROOT}/address/${address}` : null;
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
