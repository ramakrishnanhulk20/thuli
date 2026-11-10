import { createPublicClient, http, parseAbi, parseEventLogs, type Hash, type Hex, type Log } from 'viem';
import { parseAddress, type Address } from '@thuli/core';

const RECEIPT_TIMEOUT_MS = 10_000;
// One transferWithAuthorization receipt is about 2 KB. Anything near this cap is not the receipt we asked for (C41).
const MAX_RECEIPT_BYTES = 256 * 1024;

export const USDC_EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

export interface Receipt {
  status: 'success' | 'reverted';
  logs: Log[];
}

export type ReadReceipt = (hash: Hash) => Promise<Receipt>;

export interface PaidFor {
  usdc: Address;
  payer: Address;
  payTo: Address;
  nonce: Hex;
  amount: bigint;
}

function sameAddress(value: string, expected: Address): boolean {
  try {
    return parseAddress(value) === expected;
  } catch {
    return false;
  }
}

/**
 * True only for a successful transaction in which the configured network's USDC contract itself both marked this exact
 * authorization (payer and nonce) as used and moved exactly the price from the payer to payTo. A nonce that was
 * cancelled, or spent by another authorization that paid someone else, fails here, because the Transfer to us is
 * missing. Logs from any other contract are ignored, so a look-alike token cannot pass. Every address goes through the
 * one parser before it is compared (C1).
 *
 * It does not pair the two logs inside one transaction, so a facilitator that lied about which transaction settled a
 * payment could point at someone else's batch that paid us. The facilitator is trusted not to lie (threat model
 * non-goals).
 */
export function receiptPays(receipt: Receipt, expected: PaidFor): boolean {
  if (receipt.status !== 'success') return false;
  const fromUsdc = receipt.logs.filter((log) => sameAddress(log.address, expected.usdc));
  const events = parseEventLogs({ abi: USDC_EVENTS, logs: fromUsdc, strict: true });
  const nonce = expected.nonce.toLowerCase();
  const used = events.some(
    (event) => event.eventName === 'AuthorizationUsed' && sameAddress(event.args.authorizer, expected.payer) && event.args.nonce.toLowerCase() === nonce,
  );
  const paid = events.some(
    (event) =>
      event.eventName === 'Transfer' &&
      sameAddress(event.args.from, expected.payer) &&
      sameAddress(event.args.to, expected.payTo) &&
      event.args.value === expected.amount,
  );
  return used && paid;
}

/**
 * Reads a transaction receipt from rpcUrl with a timeout, a size cap and no redirects (C38, C41). The RPC's chain id is
 * checked before the first receipt is trusted and again after any failed check, so a BASE_RPC_URL pointed at another
 * chain is refused rather than read (C2).
 *
 * @throws when the chain is wrong, the transaction is not mined yet, or the RPC fails. The caller treats every throw as
 * "not confirmed".
 */
export function receiptReader(rpcUrl: string, chainId: number): ReadReceipt {
  const client = createPublicClient({
    transport: http(rpcUrl, {
      timeout: RECEIPT_TIMEOUT_MS,
      retryCount: 1,
      maxResponseBodySize: MAX_RECEIPT_BYTES,
      fetchOptions: { redirect: 'error' },
    }),
    ccipRead: false,
  });
  let chainChecked: Promise<void> | null = null;
  return async (hash) => {
    chainChecked ??= client.getChainId().then((answered) => {
      if (answered !== chainId) {
        console.error(`settlement RPC answers for chain ${answered}, not ${chainId}`);
        throw new Error('settlement RPC is on the wrong chain');
      }
    });
    try {
      await chainChecked;
    } catch (error) {
      chainChecked = null;
      throw error;
    }
    const receipt = await client.getTransactionReceipt({ hash });
    return { status: receipt.status, logs: receipt.logs };
  };
}
