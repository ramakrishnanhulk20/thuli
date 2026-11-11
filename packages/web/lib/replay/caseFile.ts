import { ETHEREUM_CHAIN, explorerTxUrl } from '../explorer';
import { loadFamily, loadShard, loadSummary, replayRoot } from './load';

/** The one farm wallet the home page follows back to its funder. */
export const CASE_WALLET = '0x12830126ed135338e179109f4e4ad77bd2a64d02';

const TX_PATTERN = /^0x[0-9a-f]{64}$/;

export interface CaseFileData {
  wallet: string;
  walletShort: string;
  funder: string;
  funderShort: string;
  ageDays: number;
  txCount: number;
  hops: number;
  others: number;
  group: number;
  groupSize: number;
  robo: number;
  usd: number;
  rule: string;
  reason: string;
  tx: string;
  txShort: string;
  txUrl: string;
  requestId: string;
}

/** Thrown at build time when the chosen wallet no longer tells the story the page tells. */
export class CaseFileError extends Error {
  override name = 'CaseFileError';
}

function short(value: string, head: number, tail: number): string {
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Reads the wallet's shard entry and its family file and checks every condition the five steps rely on.
 * @throws CaseFileError naming the first condition that fails.
 */
export function buildCaseFile(options: { wallet?: string; root?: string } = {}): CaseFileData {
  const wallet = options.wallet ?? CASE_WALLET;
  const root = options.root ?? replayRoot();
  const fail = (what: string): never => {
    throw new CaseFileError(`The case file wallet ${wallet} no longer fits the story: ${what}.`);
  };

  const detail = loadShard(wallet, root).wallets[wallet];
  if (detail === undefined) return fail('it is not in its shard');
  if (detail.outcome !== 2) fail(`its outcome is ${detail.outcome}, not 2 (hold)`);
  if (detail.rule !== 'A4') fail(`its rule is ${detail.rule}, not A4`);
  const funder = detail.facts.funder;
  if (funder === null) return fail('it has no funder');
  if (!(funder.hops >= 1)) fail(`its funder is ${funder.hops} hops away, not 1 or more`);
  if (!(funder.fanout >= 2)) fail(`its funder paid ${funder.fanout} claim wallets, not 2 or more`);
  if (!(detail.group >= 0)) fail('it is in no family');

  const family = loadFamily(detail.group, root);
  if (family.held !== family.size) fail(`its family holds ${family.held} of ${family.size} wallets, not all`);
  if (!detail.reason.includes(String(family.size))) fail(`its reason does not mention the family size ${family.size}`);
  const tx = detail.txs[0];
  if (tx === undefined || !TX_PATTERN.test(tx)) fail('its first cited transaction is not a 64 digit hash');

  const summary = loadSummary(root);
  const hash = tx as string;
  return {
    wallet,
    walletShort: short(wallet, 6, 4),
    funder: funder.address,
    funderShort: short(funder.address, 6, 4),
    ageDays: detail.facts.ageDays,
    txCount: detail.facts.txCount,
    hops: funder.hops,
    others: funder.fanout - 1,
    group: detail.group,
    groupSize: family.size,
    robo: detail.robo,
    usd: Math.round(detail.robo * summary.drop.usdPerRobo),
    rule: detail.rule,
    reason: detail.reason,
    tx: hash,
    txShort: short(hash, 10, 6),
    txUrl: explorerTxUrl(ETHEREUM_CHAIN, hash),
    requestId: detail.serv.requestId,
  };
}
