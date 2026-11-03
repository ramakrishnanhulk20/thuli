import type { AccountType } from './facts.ts';

// EIP-7702: a delegated EOA's code is this 3-byte marker followed by the delegate's address. The account still has
// its own private key, so it is a person's wallet, not a contract (threat model C20).
const DELEGATION_DESIGNATOR = '0xef0100';
const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;

/**
 * Maps the result of eth_getCode at the snapshot block to an account type. viem returns undefined for empty code, so
 * undefined and "0x" both mean a plain EOA. Text that is not hex bytes is unreadable data and maps to "unknown".
 */
export function accountTypeFromCode(code: string | undefined): AccountType {
  if (code === undefined) return 'eoa';
  const hex = code.toLowerCase();
  if (!HEX_BYTES.test(hex)) return 'unknown';
  if (hex === '0x') return 'eoa';
  if (hex.startsWith(DELEGATION_DESIGNATOR)) return 'delegated_eoa';
  return 'contract';
}
