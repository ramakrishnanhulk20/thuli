import { randomBytes } from 'node:crypto';
import { concat, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { parseAddress, type Address } from '@thuli/core';

/** The proof campaign: 1 USDC cap, 2 USDC deposited, claimant A approved for 1 USDC, one hour delay, seven days long. */
export const PROOF_TERMS = {
  perWalletCap: 1_000_000n,
  deposit: 2_000_000n,
  approvedAmount: 1_000_000n,
  rootDelay: 3600,
  runSeconds: 7 * 24 * 3600,
} as const;

export class ProofSetupError extends Error {
  override name = 'ProofSetupError';
}

const KEY = /^0x[0-9a-fA-F]{64}$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

export interface ProofEnv {
  workerKey: `0x${string}`;
  payerKey: `0x${string}`;
  rpcUrl: string;
  /** True when the RPC is a local fork, so transaction links will not resolve on the explorer. */
  rehearsal: boolean;
}

/**
 * The two keys and the RPC for prove-vault. `rpcOverride` is accepted only for a loopback address, which is how the
 * local-fork rehearsal runs; everything else uses BASE_SEPOLIA_RPC_URL over https.
 *
 * @throws ProofSetupError naming the variable at fault, never its value (C40).
 */
export function loadProofEnv(source: Record<string, string | undefined>, rpcOverride?: string): ProofEnv {
  const missing: string[] = [];
  const key = (name: string): `0x${string}` => {
    const value = (source[name] ?? '').trim();
    if (!KEY.test(value)) missing.push(name);
    return value as `0x${string}`;
  };
  const workerKey = key('WORKER_PRIVATE_KEY');
  const payerKey = key('PAYER_PRIVATE_KEY');
  let rpcUrl = (source.BASE_SEPOLIA_RPC_URL ?? '').trim();
  const rehearsal = rpcOverride !== undefined;
  if (rehearsal) {
    if (!LOOPBACK.test(rpcOverride)) throw new ProofSetupError('--rpc-url is only for a local fork: http://127.0.0.1:PORT');
    rpcUrl = rpcOverride;
  } else if (!/^https:\/\/\S+$/.test(rpcUrl)) {
    missing.push('BASE_SEPOLIA_RPC_URL');
  }
  if (missing.length > 0) {
    throw new ProofSetupError(`Missing or invalid in .env: ${missing.join(', ')} (see .env.example for the format).`);
  }
  if (workerKey.toLowerCase() === payerKey.toLowerCase()) {
    throw new ProofSetupError('WORKER_PRIVATE_KEY and PAYER_PRIVATE_KEY must be different keys: the agent is never the owner.');
  }
  return { workerKey, payerKey, rpcUrl, rehearsal };
}

/** A fresh claimant seed. Testnet only: it sits in the proof's state file so both phases derive the same wallets. */
export function newSeed(): Hex {
  return toHex(randomBytes(32));
}

/**
 * Claimant A (on the list) and claimant B (held, left off) for a seed. Their keys are derived, never stored; nobody
 * signs as them, because the agent submits A's claim and the vault pays the leaf's account whoever submits.
 */
export function claimants(seed: Hex): { a: Address; b: Address } {
  const derive = (label: string) =>
    parseAddress(privateKeyToAccount(keccak256(concat([seed, toHex(`thuli.prove-vault.${label}`)]))).address);
  return { a: derive('claimant-a'), b: derive('claimant-b') };
}

const AddressField = z.string().transform((value, ctx) => {
  try {
    return parseAddress(value);
  } catch {
    ctx.issues.push({ code: 'custom', message: 'not an address', input: value });
    return z.NEVER;
  }
});
const Hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);

export const ProofState = z.strictObject({
  chainId: z.literal(84532),
  factory: AddressField,
  vault: AddressField,
  owner: AddressField,
  agent: AddressField,
  seed: Hash32,
  root: Hash32,
  published: z.string().max(10_000),
  claimableAt: z.int().positive(),
  transactions: z
    .array(z.strictObject({ label: z.string().max(64), hash: Hash32, from: AddressField, gasUsed: z.string().regex(/^[0-9]+$/) }))
    .max(32),
});
export type ProofState = z.infer<typeof ProofState>;

export const Deployment = z.object({ chainId: z.literal(84532), factory: AddressField });
