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

/** An RPC endpoint named another chain's id. Fixed words, so the message may be logged and shown (C40). */
export class WrongChainError extends Error {
  override name = 'WrongChainError';
  override message = 'the endpoint is on another chain';
}

/**
 * A gate for the reads made through one RPC endpoint (threat model C2): a read runs only once the endpoint has named
 * `expected` as its chain id. The id is asked once, before the first read. While the endpoint names another chain,
 * every read rejects with WrongChainError and nothing more is asked of it: an endpoint of another network would answer
 * every question, about the wrong accounts. A read of the id that fails rejects the read that needed it and is asked
 * again on the next one, so one blip closes nothing for good.
 *
 * @param readChainId asks the endpoint for its chain id.
 * @param onMismatch told the id the endpoint named, each time it is read as wrong, for a log line.
 */
export function onChainOnly(
  readChainId: () => Promise<number>,
  expected: number,
  onMismatch?: (answered: number) => void,
): <T>(read: () => Promise<T>) => Promise<T> {
  let checked: Promise<void> | null = null;
  return async (read) => {
    checked ??= readChainId().then((answered) => {
      if (answered !== expected) {
        onMismatch?.(answered);
        throw new WrongChainError();
      }
    });
    try {
      await checked;
    } catch (error) {
      if (!(error instanceof WrongChainError)) checked = null;
      throw error;
    }
    return read();
  };
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
