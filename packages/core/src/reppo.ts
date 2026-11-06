import { z } from 'zod';
import type { FactName } from './facts.ts';
import { GraphRecord } from './graph.ts';
import type { Outcome } from './outcome.ts';

/** The outbound payload still held something that looks like an identifier, so it is refused before it can be sent. */
export class ReppoPayloadError extends Error {
  override name = 'ReppoPayloadError';
}

const MAX_VERDICT_REASON_CHARS = 2000;

export const ReppoVerdict = z.strictObject({
  score: z.int().min(0).max(100),
  decision: z.enum(['accept', 'reject']),
  confidence: z.enum(['low', 'medium', 'high']),
  route: z.enum(['ship', 'review', 'block']),
  reason: z.string().max(MAX_VERDICT_REASON_CHARS),
});

export type ReppoVerdict = z.infer<typeof ReppoVerdict>;

// A plain object here, so the many other fields Reppo sends are dropped by the parse and can never reach storage.
const VerdictFields = z.object({ ...ReppoVerdict.shape, reason: z.string() });

const REMOVED = '[removed]';

// One definition of a hex identifier, used both to take them out and for the last check, so the two cannot disagree (C35).
const HEX_IDENTIFIER = /0x[0-9a-f]{4,}|[0-9a-f]{16,}/i;
const HEX_IDENTIFIERS = new RegExp(HEX_IDENTIFIER.source, 'gi');
// Runs first: a shortened form can sit under the 4 character limit, and the tail after the dots must go with it.
const SHORTENED_HEX = /0x[0-9a-f]*\.{2,}(?:[0-9a-f]+\b)?|\b[0-9a-f]{4,}\.{2,}[0-9a-f]{4,}\b/gi;
// Two stored reasons have the prefix alone, "(0x evidence)" and "(0x a6cb...)", which no run check would catch.
const LONE_PREFIX = /(?<![0-9a-z])0x[0-9a-f]{0,3}(?![0-9a-z])/gi;

const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
const CLOCK = String.raw`(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?)?`;
const DATES = new RegExp(
  String.raw`\b\d{4}-\d{2}-\d{2}${CLOCK}|\b(?:(?:${MONTH})\.?\s+${DAY},?\s+|${DAY}\s+(?:${MONTH})\.?,?\s+)\d{4}\b${CLOCK}`,
  'gi',
);

const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
const CURRENCY_AMOUNTS = new RegExp(String.raw`\p{Sc}\s?${NUMBER}`, 'gu');
// All capitals after a number reads as a ticker, so a token nobody listed is still caught. EOA is the one capital word
// real reasons put after a count. A lowercase ticker outside the next line's few words is not caught.
const TICKER_AMOUNTS = new RegExp(String.raw`\b${NUMBER}\s?(?!EOAS?\b)[A-Z][A-Z0-9]{1,9}\b`, 'g');
const WORD_AMOUNTS = new RegExp(String.raw`\b${NUMBER}\s?(?:eth|ether|wei|gwei|usdc|usdt|dai|tokens?)\b`, 'gi');

const LABEL = String.raw`(?:transaction hash|tx hash|txn|txs?|hash(?:es)?)`;
const LABEL_WITH_REMOVED = new RegExp(String.raw`\b${LABEL}\b(?:\s*\d+)?\s*:?\s*\[removed\]`, 'gi');
// A bracket holding only placeholders says nothing more than an empty one. The placeholder itself never matches here,
// because after its opening "[" neither a closing bracket nor another placeholder follows.
const HOLLOW_BRACKETS = /[([{][\s,;:]*(?:\d+[:;]\s*)?(?:\[removed\][\s,;:]*)*[)\]}]/g;
// Citation marks such as [1] or [1-2] pointed at a hash that is gone, so they point at nothing now.
const ORPHAN_CITATIONS = /\[\d+(?:\s?[-–,]\s?\d+)*\]/g;
const DANGLING_LABEL = new RegExp(String.raw`\b${LABEL}\b:?(?=\s*(?:[,;.)]|$))`, 'gi');

/**
 * Takes everything that could tie a sentence to one wallet out of a text bound for Reppo's public pages (C35): 0x hex
 * runs of 4 or more characters, shortened forms such as 0xa9ac...4573, bare hex runs of 16 or more, dates and timestamps
 * (ISO, YYYY-MM-DD, and month and day forms with a year), and amounts in a currency or a token. Each becomes [removed].
 * A transaction label left pointing at nothing goes too, as does a bracket with nothing left in it.
 *
 * Text is normalised first, so a full-width digit or a zero-width character cannot split a hex run past the checks.
 * Ordinary counts such as "63 wallets" stay. This does not catch names, such as an ENS name or an exchange label: the
 * facts carry none and a stored reason has never held one, which is what the scan of all 37,323 stored reasons showed.
 */
export function stripIdentifiers(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(SHORTENED_HEX, REMOVED)
    .replace(HEX_IDENTIFIERS, REMOVED)
    .replace(LONE_PREFIX, REMOVED)
    .replace(DATES, REMOVED)
    .replace(CURRENCY_AMOUNTS, REMOVED)
    .replace(TICKER_AMOUNTS, REMOVED)
    .replace(WORD_AMOUNTS, REMOVED)
    .replace(LABEL_WITH_REMOVED, '')
    .replace(HOLLOW_BRACKETS, '')
    .replace(ORPHAN_CITATIONS, '')
    .replace(DANGLING_LABEL, '')
    .replace(/\s+([.,;:)\]])/g, '$1')
    .replace(/([.,;:])[.,;:]+/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:]+/, '')
    .trim();
}

const RULE_CODE = String.raw`\b(?:A[1-9]|B[12])\b`;
const RULE_CONNECTOR = String.raw`(?:\b(?:[Uu]nder|[Pp]er|[Bb]y|[Vv]ia|[Ff]rom|[Aa]t)\s+)?`;
const RULE_WORDS = String.raw`(?:[Tt]he\s+)?(?:[Ss]tart(?:ing)?\s+)?(?:[Rr]ule\s+)?`;
const LEADING_RULE_CODE = new RegExp(String.raw`^\s*${RULE_CONNECTOR}${RULE_WORDS}${RULE_CODE}(?:['’]s)?\s*[:;,.]?\s*`);
const RULE_REFERENCE = new RegExp(String.raw`${RULE_CONNECTOR}${RULE_WORDS}${RULE_CODE}(?:['’]s)?(?:\s+[Rr]ule\b)?`, 'g');

// Rule codes are Thuli's own shorthand, and an evaluator on the one real check marked the reason down for an unexplained B1.
function withoutRuleCodes(reason: string): string {
  return reason.replace(LEADING_RULE_CODE, '').replace(RULE_REFERENCE, '');
}

const ACTION_WORDS: Record<Outcome, string> = {
  full: 'full reward',
  partial: 'partial reward',
  hold: 'hold for a person to review',
  exclude: 'exclude',
};

const ACCOUNT_WORDS: Record<GraphRecord['account_type'], string> = {
  eoa: 'normal account',
  contract: 'smart contract account',
  delegated_eoa: 'normal account with delegated code',
  unknown: 'account type unreadable',
};

const FUNDER_WORDS: Record<GraphRecord['first_funder_kind'], string> = {
  exchange: 'an exchange',
  bridge: 'a bridge',
  contract: 'a contract',
  wallet: 'a wallet',
  unknown: 'an unidentified source',
  none: '',
};

const FACT_WORDS: Record<FactName, string> = {
  walletAgeDays: 'wallet age',
  txCountAtSnapshot: 'transaction count',
  accountType: 'account type',
  firstFunder: 'first funder',
  group: 'linked group',
  sharedDepositAddress: 'shared deposit address',
  claimPaidToOtherAddress: 'where the claim was paid',
  evidenceTxs: 'evidence transactions',
};

const USER_PROMPT =
  "User prompt: You screen one wallet on a crypto project's airdrop list. Decide: full reward, partial reward, hold for a person to review, or exclude. ";

const RULES =
  'Be fair to real users: ordinary people often share a popular bridge, an exchange or a faucet, and a new wallet is not a farm by itself. Links a wallet made itself are strong evidence of one operator. Links it did not make are weak on their own. A funding burst is a pattern, not proof of one owner, so it caps a wallet at a partial reward and never justifies a hold.';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function funderFacts(record: GraphRecord): string[] {
  if (record.first_funder_kind === 'none') return ['no first funder on record'];
  const funded = [`first funded by ${FUNDER_WORDS[record.first_funder_kind]}`];
  if (record.first_funder_claim_wallets === null) return funded;
  // Our count includes this wallet and the reasons count only the others. On the one real check every evaluator read
  // that gap as a factual error, so the facts here use the reasons' count.
  const others = Math.max(record.first_funder_claim_wallets - 1, 0);
  return [...funded, `it funded ${others === 0 ? 'no' : others} other ${others === 1 ? 'wallet' : 'wallets'} on this list`];
}

function groupFacts(record: GraphRecord): string[] {
  if (record.group_size === 0) return ['no group of linked wallets', 'no sweep to a shared collector'];
  return [
    `in a group of ${plural(record.group_size, 'linked wallet')}`,
    (record.group_same_funder ?? 0) >= 2 ? 'the group shares funding' : 'the group does not share funding',
    record.group_swept_to_shared_collector ? 'the group sweeps to a shared collector' : 'no sweep to a shared collector',
    record.group_links_made_by_wallet ? 'this wallet made the links itself' : 'this wallet did not make the links',
  ];
}

// Every clause is a fixed phrase or a count, so nothing from the record can carry an identifier. evidence_tx_hashes and
// start_rule are never read here.
function factSentences(record: GraphRecord): string {
  const facts = [
    record.wallet_age_days === null ? 'wallet age unreadable' : `wallet age ${plural(record.wallet_age_days, 'day')}`,
    record.tx_count === null ? 'transaction count unreadable' : `${plural(record.tx_count, 'transaction')} before the snapshot`,
    ACCOUNT_WORDS[record.account_type],
    ...funderFacts(record),
    ...groupFacts(record),
    record.shared_deposit_claimants === 0
      ? 'no shared deposit address'
      : `its deposit address is used by ${plural(record.shared_deposit_claimants, 'listed wallet')}`,
    record.funding_burst_wallets === 0 ? 'no funding burst' : `first funded in a burst of ${plural(record.funding_burst_wallets, 'wallet')}`,
  ];
  if (record.unreadable_facts.length > 0) {
    facts.push(`unreadable facts: ${record.unreadable_facts.map((name) => FACT_WORDS[name]).join(', ')}`);
  }
  facts.push(`the code's own starting decision: ${ACTION_WORDS[record.start_outcome]}`);
  return `${facts.join('; ')}.`;
}

/**
 * Builds the text Reppo evaluates for one decision, in taskType 'response' form: the task and the fairness rules as the
 * user prompt, the wallet's facts as words and counts, then Thuli's decision and reason as the AI response. No rule code
 * and no transaction hash reaches the text.
 *
 * The last step is the one check over the whole outbound payload (C35).
 *
 * @throws ZodError when the record does not match GraphRecord.
 * @throws ReppoPayloadError when a 0x hex run of 4 or more, or a bare hex run of 16 or more, is still in the payload.
 */
export function reppoInput(record: GraphRecord, action: Outcome, reason: string): string {
  const facts = factSentences(GraphRecord.parse(record));
  const payload = `${USER_PROMPT}${RULES} Facts from public chain data, identifiers removed: ${facts}\n\nAI response: Decision: ${ACTION_WORDS[action]}. Reason: ${stripIdentifiers(withoutRuleCodes(reason))}`;
  if (HEX_IDENTIFIER.test(payload)) throw new ReppoPayloadError('the outbound payload still held a hex identifier');
  return payload;
}

/**
 * Reads the `result` object of a finished evaluation. Reppo's text is treated like any other input (C35): only the five
 * fields are kept, the reason loses its control and format characters and is cut to 2000 characters, and anything out
 * of range or out of shape gives null.
 */
export function parseVerdict(raw: unknown): ReppoVerdict | null {
  const parsed = VerdictFields.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, reason: parsed.data.reason.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, MAX_VERDICT_REASON_CHARS) };
}
