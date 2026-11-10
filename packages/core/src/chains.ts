export const CHAINS = {
  ethereum: { id: 1 },
  base: { id: 8453 },
  // The vault's testnet: Circle's test USDC there, and the explorer every printed transaction link points to.
  'base-sepolia': {
    id: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org',
  },
} as const;

export type ChainName = keyof typeof CHAINS;

export const CHAIN_NAMES = Object.keys(CHAINS) as [ChainName, ...ChainName[]];

export class ChainError extends Error {
  override name = 'ChainError';
}

// Canonical spellings only: decimal without leading zeros, or a JSON-RPC hex quantity (no leading zeros either).
const DECIMAL_ID = /^(0|[1-9][0-9]{0,15})$/;
const HEX_ID = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,13})$/;

function chainById(id: number): ChainName | undefined {
  return CHAIN_NAMES.find((name) => CHAINS[name].id === id);
}

/**
 * The one chain parser (threat model C2). Number, decimal text, hex text and chain name all go through the same
 * lookup in CHAINS, so 8453 and "0x2105" can never resolve differently.
 *
 * @throws ChainError for anything that is not one of the configured chains.
 */
export function parseChain(input: number | string): ChainName {
  let id: number | undefined;
  if (typeof input === 'number') {
    if (Number.isSafeInteger(input)) id = input;
  } else if (typeof input === 'string') {
    if (Object.hasOwn(CHAINS, input)) return input as ChainName;
    if (DECIMAL_ID.test(input)) id = Number(input);
    else if (HEX_ID.test(input)) id = Number.parseInt(input.slice(2), 16);
  }
  const name = id === undefined ? undefined : chainById(id);
  if (!name) throw new ChainError('unsupported chain');
  return name;
}
