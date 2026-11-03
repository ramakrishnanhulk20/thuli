import { z } from 'zod';
import { isCanonicalAddress, type Address } from './address.ts';

// Every field below is a number, a boolean, a fixed word, an address or a hash. There is deliberately no free-text
// field anywhere in what the model sees, so text a stranger wrote on-chain has no way in (threat model C14, C34).

export const ACCOUNT_TYPES = ['eoa', 'contract', 'delegated_eoa', 'unknown'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const FUNDER_KINDS = ['exchange', 'bridge', 'contract', 'wallet', 'unknown'] as const;

export const FACT_NAMES = [
  'walletAgeDays',
  'txCountAtSnapshot',
  'accountType',
  'firstFunder',
  'group',
  'sharedDepositAddress',
  'claimPaidToOtherAddress',
  'evidenceTxs',
] as const;
export type FactName = (typeof FACT_NAMES)[number];

/** Upper bound on hashes carried per wallet, so one wallet cannot make a run input unbounded (C41). */
export const MAX_EVIDENCE_TXS = 256;

export const CanonicalAddress = z.custom<Address>(
  (value) => typeof value === 'string' && isCanonicalAddress(value),
  'address must be in the canonical checksummed form',
);

/** Transaction hashes are stored lowercase only, so cited and fetched hashes compare as equal strings (C13). */
export const TxHash = z.string().regex(/^0x[0-9a-f]{64}$/, 'transaction hash must be 0x and 64 lowercase hex');

const Count = z.int().min(0);

export const Facts = z.strictObject({
  walletAgeDays: Count.nullable(),
  txCountAtSnapshot: Count.nullable(),
  accountType: z.enum(ACCOUNT_TYPES),
  firstFunder: z
    .strictObject({
      address: CanonicalAddress,
      kind: z.enum(FUNDER_KINDS),
      fanoutInList: Count.nullable(),
      hopsTraced: Count,
    })
    .nullable(),
  group: z
    .strictObject({
      size: Count,
      sameFunderWithinWindow: Count.nullable(),
      sweptToSharedCollector: z.boolean(),
      authoredEvidence: z.boolean(),
    })
    .nullable(),
  sharedDepositAddress: z.strictObject({ sharedWithClaimants: Count }).nullable(),
  claimPaidToOtherAddress: z.boolean().nullable(),
  evidenceTxs: z.array(TxHash).max(MAX_EVIDENCE_TXS),
  missing: z.array(z.enum(FACT_NAMES)).max(FACT_NAMES.length),
});

export type Facts = z.infer<typeof Facts>;
