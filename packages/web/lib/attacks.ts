import { createPublicClient, encodeAbiParameters, http, isAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { VAULT_ABI } from './vaultAbi';

/** The public endpoint packages/api/src/config.ts names as BASE_SEPOLIA_RPC. */
export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

/** What the page needs from the vault proof record, as plain values. */
export interface ProofFacts {
  chainId: number;
  vault: string;
  token: string;
  owner: string;
  agent: string;
  root: string;
  perWalletCap: string;
  paidAccount: string;
  paidAmount: string;
  refusedAccount: string;
  explorer: string;
}

export type AttackStatus = 'refused' | 'not-refused' | 'could-not-run';
export type AttackTarget = 'chain' | 'site';

export interface AttackResult {
  status: AttackStatus;
  /** What came back, ready to show. Empty for a call that did not run. */
  answer: string;
  /** A second quiet line, such as the note for a campaign that has ended. */
  note: string | null;
  ms: number;
  target: AttackTarget;
}

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;
const OVERSIZED_LENGTH = 2000;

export const MARKUP_REASON = '<img src=x onerror="window.__thuliBroken=true"> <a href="https://example.invalid">claim</a>';

/** The vault's Merkle leaf: chain id, vault, account and amount, hashed twice like OpenZeppelin's StandardMerkleTree. */
export function leafFor(chainId: number, vault: string, account: string, amount: bigint): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [BigInt(chainId), vault as Address, account as Address, amount],
  );
  return keccak256(keccak256(encoded));
}

/** The leaf of the one wallet on the vault's list, rebuilt here from the record's values. */
export function rebuiltLeaf(facts: ProofFacts): Hex {
  return leafFor(facts.chainId, facts.vault, facts.paidAccount, BigInt(facts.paidAmount));
}

/** True when the list's single leaf, rebuilt here, is the root the record holds. */
export function rootMatches(facts: ProofFacts): boolean {
  return rebuiltLeaf(facts).toLowerCase() === facts.root.toLowerCase();
}

/**
 * The vault's state() view, written from the struct in ARCHITECTURE.md section 4.2. A test compares its fields, in order,
 * with the generated ABI in packages/worker/src/vault/abi.ts.
 */
export const STATE_SIGNATURE =
  'function state() view returns ((address token, address owner, address agent, uint256 perWalletCap, uint64 endTime, uint32 rootDelay, uint256 deposited, uint256 totalPaid, bytes32 activeRoot, bytes32 pendingRoot, uint64 pendingClaimableAt, bool paused) s)' as const;

const STATE_ABI = parseAbi([STATE_SIGNATURE]);

/** The vault's active root as the page knows it: not read yet, not readable, or read. */
export type LiveRoot = { status: 'reading' } | { status: 'failed' } | { status: 'read'; root: string };

/** All the state read needs from a chain client. */
export interface StateReader {
  readContract: (parameters: never) => Promise<unknown>;
}

const ROOT_HEX = /^0x[0-9a-fA-F]{64}$/;

/** Reads activeRoot from the vault's state(). A call that fails, or an answer that is not a root, is a failed read. */
export async function readActiveRoot(client: StateReader, vault: string): Promise<LiveRoot> {
  try {
    const state = await client.readContract({ address: vault as Address, abi: STATE_ABI, functionName: 'state' } as never);
    const root = typeof state === 'object' && state !== null ? (state as { activeRoot?: unknown }).activeRoot : undefined;
    if (typeof root !== 'string' || !ROOT_HEX.test(root)) return { status: 'failed' };
    return { status: 'read', root };
  } catch {
    return { status: 'failed' };
  }
}

export type RootLine =
  | { kind: 'reading' }
  | { kind: 'match'; root: string }
  | { kind: 'unreadable' }
  | { kind: 'mismatch'; root: string };

/**
 * What the root line says. The rebuilt leaf is checked against the root the record holds first, silently: a record that
 * disagrees is a mismatch whatever the vault says. Then it is checked against the vault's live active root, once that
 * has been read. Only a mismatch switches the vault rows off.
 */
export function rootLineState(leaf: string, live: LiveRoot, recordRoot: string): RootLine {
  if (leaf.toLowerCase() !== recordRoot.toLowerCase()) return { kind: 'mismatch', root: recordRoot };
  if (live.status === 'failed') return { kind: 'unreadable' };
  if (live.status === 'reading') return { kind: 'reading' };
  return leaf.toLowerCase() === live.root.toLowerCase() ? { kind: 'match', root: live.root } : { kind: 'mismatch', root: live.root };
}

export function rootLineText(line: RootLine): string {
  switch (line.kind) {
    case 'reading':
      return "READING THE VAULT'S ACTIVE ROOT";
    case 'match':
      return `LIST ROOT REBUILT IN YOUR BROWSER MATCHES THE VAULT'S ACTIVE ROOT ${shortHash(line.root)}`;
    case 'unreadable':
      return 'COULD NOT READ THE VAULT. THE ROWS BELOW MAY NOT RUN.';
    case 'mismatch':
      return `LIST ROOT REBUILT IN YOUR BROWSER: DOES NOT MATCH ${shortHash(line.root)}`;
  }
}

/**
 * The address with the case of its first hex letter flipped, so the checksum is wrong and nothing else changes.
 * @throws RangeError for an address with no hex letter, which has no case to flip.
 */
export function mistypedAddress(address: string): string {
  const body = address.slice(2);
  const at = body.search(/[a-fA-F]/);
  if (at < 0) throw new RangeError('this address has no hex letter to flip');
  const letter = body.charAt(at);
  const flipped = letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase();
  return `0x${body.slice(0, at)}${flipped}${body.slice(at + 1)}`;
}

/** True for an address whose letters follow the checksum rule, or has no letters to check. */
export function hasValidChecksum(address: string): boolean {
  return isAddress(address, { strict: true });
}

const ADDRESS_IN_TEXT = /0x[0-9a-fA-F]{40}/g;

export function shortenAddresses(text: string): string {
  return text.replace(ADDRESS_IN_TEXT, (found) => `${found.slice(0, 6)}…${found.slice(-4)}`);
}

function argText(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return shortenAddresses(value);
  return String(value);
}

/** `InvalidProof()` or `NothingToClaim(0xFE2B…5CdD)`: the error's name with its arguments, addresses shortened. */
export function describeRevert(name: string, args: readonly unknown[] | undefined): string {
  return `${name}(${(args ?? []).map(argText).join(', ')})`;
}

interface Chained {
  name?: unknown;
  cause?: unknown;
  data?: unknown;
  signature?: unknown;
}

function revertIn(error: unknown): Chained | null {
  let current: unknown = error;
  for (let depth = 0; depth < 12 && typeof current === 'object' && current !== null; depth += 1) {
    const link = current as Chained;
    if (link.name === 'ContractFunctionRevertedError') return link;
    current = link.cause;
  }
  return null;
}

const CAMPAIGN_NOTES = new Map<string, string>([
  ['CampaignEnded', "The proof vault's campaign has ended, so the vault refuses every claim."],
  ['EnforcedPause', "The proof vault is paused, so the vault refuses every claim."],
]);

/**
 * Reads what a simulation threw. A revert, with or without a name the ABI knows, is the vault refusing; anything else
 * (a network failure, an endpoint that did not answer) means the call never reached the chain.
 */
export function classifyVaultError(error: unknown): { status: 'refused' | 'could-not-run'; answer: string; note: string | null } {
  const revert = revertIn(error);
  if (revert === null) return { status: 'could-not-run', answer: '', note: null };
  const data = revert.data as { errorName?: unknown; args?: readonly unknown[] } | undefined;
  if (data !== undefined && typeof data.errorName === 'string') {
    return { status: 'refused', answer: describeRevert(data.errorName, data.args), note: CAMPAIGN_NOTES.get(data.errorName) ?? null };
  }
  const signature = typeof revert.signature === 'string' ? ` (${revert.signature})` : '';
  return { status: 'refused', answer: `Reverted${signature}`, note: null };
}

/** Times one call and files its outcome: it threw, so it was classified; it returned, so the call went through. */
export async function runVaultCall(simulate: () => Promise<unknown>, now: () => number = () => performance.now()): Promise<AttackResult> {
  const started = now();
  try {
    await simulate();
  } catch (error) {
    const read = classifyVaultError(error);
    return { ...read, ms: Math.round(now() - started), target: 'chain' };
  }
  return { status: 'not-refused', answer: '', note: null, ms: Math.round(now() - started), target: 'chain' };
}

export function createChainClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });
}

/** All a vault attack needs from a chain client. */
export interface Simulator {
  simulateContract: (parameters: never) => Promise<unknown>;
}

/** A vault simulation: a read that sends nothing and needs no wallet. */
export interface VaultCall {
  functionName: 'claim' | 'withdrawAfterEnd' | 'postRoot';
  args: readonly unknown[];
  from: string;
}

export function vaultCalls(facts: ProofFacts): Record<'claimOther' | 'claimTwice' | 'claimMore' | 'withdraw' | 'postRoot', VaultCall> {
  const amount = BigInt(facts.paidAmount);
  return {
    claimOther: { functionName: 'claim', args: [facts.refusedAccount, amount, []], from: facts.refusedAccount },
    claimTwice: { functionName: 'claim', args: [facts.paidAccount, amount, []], from: facts.paidAccount },
    claimMore: { functionName: 'claim', args: [facts.paidAccount, 2n * amount, []], from: facts.paidAccount },
    withdraw: { functionName: 'withdrawAfterEnd', args: [facts.agent], from: facts.agent },
    postRoot: {
      functionName: 'postRoot',
      args: [leafFor(facts.chainId, facts.vault, DEAD_ADDRESS, amount), amount],
      from: DEAD_ADDRESS,
    },
  };
}

export function runVaultAttack(client: Simulator, facts: ProofFacts, call: VaultCall): Promise<AttackResult> {
  return runVaultCall(() =>
    client.simulateContract({
      address: facts.vault as Address,
      abi: VAULT_ABI,
      functionName: call.functionName,
      args: call.args,
      account: call.from as Address,
    } as never),
  );
}

export interface ApiAttack {
  path: string;
  headers: Record<string, string>;
  body: string;
  /** The statuses that count as the route refusing. */
  refusedStatuses: readonly number[];
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function apiAttacks(facts: ProofFacts): Record<'mistyped' | 'unpaid' | 'forged' | 'oversized', ApiAttack> {
  return {
    mistyped: {
      path: '/api/check',
      headers: JSON_HEADERS,
      body: JSON.stringify({ wallet: mistypedAddress(facts.paidAccount) }),
      refusedStatuses: [400],
    },
    unpaid: {
      path: '/api/x402/screen',
      headers: JSON_HEADERS,
      body: JSON.stringify({ wallet: facts.paidAccount }),
      refusedStatuses: [402],
    },
    forged: {
      path: '/api/x402/screen',
      headers: { ...JSON_HEADERS, 'PAYMENT-SIGNATURE': 'not-a-payment' },
      body: JSON.stringify({ wallet: facts.paidAccount }),
      refusedStatuses: [402, 400],
    },
    oversized: {
      path: '/api/check',
      headers: JSON_HEADERS,
      body: JSON.stringify({ wallet: facts.paidAccount.padEnd(OVERSIZED_LENGTH, '0') }),
      refusedStatuses: [413, 400],
    },
  };
}

const STATUS_WORDS = new Map<number, string>([
  [400, 'Bad request'],
  [402, 'Payment required'],
  [413, 'Payload too large'],
]);

/** The error or key text of a JSON answer: its `error` when it has one, else the first key that is true or text. */
export function answerText(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error !== '') return record.error;
    for (const [key, value] of Object.entries(record)) {
      if (value === true) return key;
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return STATUS_WORDS.get(status) ?? 'No text in the answer';
}

/**
 * Files an HTTP answer: a status the attack expected, or a 429 for this caller's limit, is the route refusing; any 2xx
 * means the request went through; every other status means the route did not give the answer the attack is about, so
 * it did not run.
 */
export function classifyApiAnswer(status: number, body: unknown, refusedStatuses: readonly number[], ms: number): AttackResult {
  // A route that has reached its limit for this caller is refusing the request too, whichever attack it was.
  if (status === 429) return { status: 'refused', answer: "429 this caller's limit was reached", note: null, ms, target: 'site' };
  if (refusedStatuses.includes(status)) {
    return { status: 'refused', answer: `${status} ${answerText(status, body)}`, note: null, ms, target: 'site' };
  }
  if (status >= 200 && status < 300) return { status: 'not-refused', answer: `${status}`, note: null, ms, target: 'site' };
  return { status: 'could-not-run', answer: `${status}`, note: null, ms, target: 'site' };
}

export async function runApiAttack(attack: ApiAttack, request: typeof fetch = fetch, now: () => number = () => performance.now()): Promise<AttackResult> {
  const started = now();
  let response: Response;
  try {
    response = await request(attack.path, { method: 'POST', headers: attack.headers, body: attack.body, cache: 'no-store' });
  } catch {
    return { status: 'could-not-run', answer: '', note: null, ms: Math.round(now() - started), target: 'site' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return classifyApiAnswer(response.status, body, attack.refusedStatuses, Math.round(now() - started));
}

/**
 * The markup attack: the reason was rendered as a plain text node, so it is refused when the page's flag is untouched
 * and the paragraph has no child elements.
 */
export function judgeRenderedReason(paragraph: { childElementCount: number } | null, flag: unknown, ms: number): AttackResult {
  if (paragraph === null) return { status: 'could-not-run', answer: '', note: null, ms, target: 'site' };
  if (flag === undefined && paragraph.childElementCount === 0) {
    return { status: 'refused', answer: 'Rendered as text, 0 elements', note: null, ms, target: 'site' };
  }
  return { status: 'not-refused', answer: `${paragraph.childElementCount} elements`, note: null, ms, target: 'site' };
}

/** First 10 and last 6 characters, for the root and for transaction hashes. */
export function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
