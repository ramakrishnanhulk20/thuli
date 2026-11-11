import { DEFAULT_SETTINGS, Facts, parseAddress, Settings, type Address, type FunderKind, type ScreenedChain } from '@thuli/core';
import type { AskFactsInput, FunderLink } from '@thuli/store';

/**
 * What a campaign screening cannot measure from one wallet's own history and the campaign's own asks, stored on every
 * decision so the board says so. A shared deposit address and a sweep to a shared collector need every asking wallet's
 * sends; a funding burst needs their funding amounts and times; no claim has been paid yet to be redirected; and the
 * first funder is the wallet's direct one, so a funding that reached it through pass-through wallets, which the replay
 * follows back to its source, is linked by the last hop only.
 */
export const CAMPAIGN_NOT_CHECKED = [
  'sharedDepositAddress',
  'sweptToSharedCollector',
  'claimPaidToOtherAddress',
  'fundingBurst',
  'passThroughFunding',
] as const;

// The kinds that can be one person's own wallet. An exchange, a bridge or a contract pays strangers all day, so sharing
// one says nothing about who owns the wallets (C16). Unknown links on purpose: doubt should make a hold more likely.
const LINKING_KINDS: readonly string[] = ['wallet', 'unknown'] satisfies readonly FunderKind[];

const isLinkingKind = (kind: string) => LINKING_KINDS.includes(kind);

/** What a campaign screening knows about the campaign's other asks. */
export interface CampaignAsks {
  /** The first funders of the campaign's other decided asks, from funderLinks. */
  links: readonly FunderLink[];
  /** Other wallets known to have asked here that carry no funder record, such as one whose own screening failed. */
  askers: readonly string[];
}

/**
 * The wallet's connected part of the campaign's ask graph, the graph linkClaimWallets in core's factsEngine.ts builds
 * for a claim list: an edge joins each asking wallet to its first funder when that funder is of a linking kind, and a
 * funder that also asked is a node like any other. linkWallets are the asking wallets the links themselves name.
 * Breadth first over every edge once, so the work is linear in the number of links (C41).
 */
function familyOf(wallet: Address, single: Facts, links: readonly FunderLink[]): { family: Set<Address>; linkWallets: Set<Address> } {
  const next = new Map<Address, Address[]>();
  const edge = (from: Address, to: Address) => {
    const known = next.get(from);
    if (known === undefined) next.set(from, [to]);
    else known.push(to);
  };
  const join = (a: Address, b: Address) => {
    edge(a, b);
    edge(b, a);
  };
  const linkWallets = new Set<Address>();
  for (const link of links) {
    const asker = parseAddress(link.wallet);
    if (asker === wallet) continue;
    linkWallets.add(asker);
    if (isLinkingKind(link.funderKind)) join(asker, parseAddress(link.funderAddress));
  }
  const own = single.firstFunder;
  if (own !== null && isLinkingKind(own.kind)) join(wallet, parseAddress(own.address));
  const family = new Set<Address>([wallet]);
  const waiting = [wallet];
  for (let at = 0; at < waiting.length; at += 1) {
    for (const neighbour of next.get(waiting[at] as Address) ?? []) {
      if (family.has(neighbour)) continue;
      family.add(neighbour);
      waiting.push(neighbour);
    }
  }
  return { family, linkWallets };
}

/**
 * The addresses in the wallet's family that no link names as an asking wallet: funders that may have asked without
 * leaving a funder record. The caller looks each one up in the store and passes the ones that asked to campaignFacts as
 * CampaignAsks.askers, which keeps campaignFacts pure. Pure.
 */
export function familyAddressesToCheck(wallet: string, single: Facts, links: readonly FunderLink[]): Address[] {
  const self = parseAddress(wallet);
  const { family, linkWallets } = familyOf(self, single, links);
  return [...family].filter((address) => address !== self && !linkWallets.has(address));
}

/**
 * One asking wallet's facts with the campaign's own asks linked in, as the replay links a claim list.
 *
 * The group is every asking wallet in the wallet's connected part of the ask graph (familyOf), itself included, so
 * wallets that share a funder are one family, a funder that also asked is in the family of the wallets it paid, and a
 * chain in which each wallet funded the next is one family; the group exists from two asking wallets up. The evidence
 * flags mirror buildReplayFacts in core's factsEngine.ts: authoredEvidence and sweptToSharedCollector come only from
 * sweeps there (lines 548 to 549), which a campaign cannot see, so both are false and the group can hold the wallet under
 * A4 but never exclude it under A3 (C15); linkedByWallet is true when this wallet is the first funder of another asking
 * wallet and is itself of a linking kind (line 541, fundedAnotherClaimWallet), read from that ask's stored funder kind,
 * which is this wallet's own kind as the chain showed it. The replay's other source of linkedByWallet, a sweep shared
 * with one other wallet (sendHashes, line 552), is unseen here and listed as not checked. sameFunderWithinWindow is
 * null, because a link carries no funding time.
 *
 * fanoutInList is the number of asking wallets this wallet's own first funder paid, this one included, or null when that
 * funder is an exchange, bridge or contract, which links nobody (C16). A link counts only when its stored funder kind is
 * a linking one. Every address is compared after parseAddress, so one funder or wallet in any spelling is one (C1). Every
 * other fact passes through as `single` has it. Pure.
 *
 * @param wallet The asking wallet, in any spelling parseAddress accepts.
 * @param single The wallet's own facts in single-wallet scope (inSingleScope), its first funder's kind already read.
 * @param asks The campaign's other asks: funderLinks, and the asking wallets found by familyAddressesToCheck.
 * @param settings The campaign's settings. Linking uses no threshold of its own: the start rules apply them.
 * @returns The facts, checked by Facts.parse, and the facts this screening could not measure (CAMPAIGN_NOT_CHECKED).
 * @throws AddressError when a link or asker is not an address, so a damaged record fails the screening instead of
 *   quietly counting one wallet fewer. ZodError when the settings or the result are not valid.
 */
export function campaignFacts(
  wallet: string,
  single: Facts,
  asks: CampaignAsks,
  settings: Settings,
): { facts: Facts; notChecked: string[] } {
  Settings.parse(settings);
  const self = parseAddress(wallet);
  const { family, linkWallets } = familyOf(self, single, asks.links);
  const askers = new Set<Address>([self, ...linkWallets, ...asks.askers.map(parseAddress)]);
  const size = [...family].filter((address) => askers.has(address)).length;

  const funder = single.firstFunder;
  let firstFunder = funder;
  if (funder !== null) {
    const source = parseAddress(funder.address);
    const paid = new Set<Address>([self]);
    for (const link of asks.links) {
      if (isLinkingKind(link.funderKind) && parseAddress(link.funderAddress) === source) paid.add(parseAddress(link.wallet));
    }
    firstFunder = { ...funder, fanoutInList: isLinkingKind(funder.kind) ? paid.size : null };
  }
  const linkedByWallet = asks.links.some(
    (link) => isLinkingKind(link.funderKind) && parseAddress(link.funderAddress) === self && parseAddress(link.wallet) !== self,
  );

  let group = single.group;
  if (size >= 2) {
    group =
      group === null
        ? { size, sameFunderWithinWindow: null, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet }
        : { ...group, size: Math.max(group.size, size), linkedByWallet: group.linkedByWallet || linkedByWallet };
  }
  return { facts: Facts.parse({ ...single, firstFunder, group }), notChecked: [...CAMPAIGN_NOT_CHECKED] };
}

/**
 * The settings a campaign is screened under: DEFAULT_SETTINGS, then each setting the campaign row changes, then the
 * row's own partial share, which is the one decideAsk checks a share against. A row from before campaigns carried
 * settings, or one whose settings are null, changes nothing.
 *
 * @throws ZodError when the result is not a valid Settings, such as an unknown key or a value out of range, so a bad
 *   row stops the screening instead of running on a guess.
 */
export function campaignSettings(campaign: { partialShareBps: number; settings?: Partial<Settings> | null }): Settings {
  const changed = Object.fromEntries(
    Object.entries(campaign.settings ?? {}).filter(([, value]) => value !== undefined && value !== null),
  );
  return Settings.parse({ ...DEFAULT_SETTINGS, ...changed, partialShareBps: campaign.partialShareBps });
}

/**
 * The public facts decideAsk stores with a decision, in the store's own field names, with the chain they were read on.
 * The campaign screening always names the chain; left out, it is 'ethereum', the only chain read before Base history.
 */
export function askFactsOf(facts: Facts, chain: ScreenedChain = 'ethereum'): AskFactsInput {
  const funder = facts.firstFunder;
  return {
    ageDays: facts.walletAgeDays,
    txCount: facts.txCountAtSnapshot,
    accountType: facts.accountType,
    funder:
      funder === null
        ? null
        : { address: funder.address, kind: funder.kind, fanout: funder.fanoutInList, hops: funder.hopsTraced },
    burstWallets: facts.fundingBurst?.wallets ?? null,
    groupSize: facts.group?.size ?? null,
    missing: [...facts.missing],
    chain,
  };
}
