import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  AppealError,
  appealMessage,
  AppealRecord,
  appealTextHash,
  checkAppeal,
  computeStart,
  DEFAULT_SETTINGS,
  Facts,
  settleAppeal,
  toGraphRecord,
  type AppealInput,
} from '@thuli/core';
import { adviseOnAppeal } from '../src/appeal/advice.ts';
import { AppealStore } from '../src/appeal/store.ts';
import { EnvError } from '../src/env.ts';
import { connectionFromEnv } from '../src/serv/client.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT_FILE = path.join(REPO_ROOT, 'data', 'feedback', 'appeals.jsonl');

const CAMPAIGN = 'thuli-appeal-proof';
const OTHER_CAMPAIGN = 'other-campaign';
const APPEAL_TEXT = 'This wallet belongs to one person. The contract that funded it is a public payroll service.';
const SECOND_APPEAL_TEXT = 'A second appeal from the same wallet, sent while the first is still open.';
const APPEALED_REASON = 'Test decision for the appeal proof: a contract funder also funded 30 listed wallets.';
const OWNER_NOTE = 'Owner checked the payroll service.';
const TWO_HOURS_SECONDS = 7_200;

class ProofFailed extends Error {
  override name = 'ProofFailed';
}

function must(condition: boolean, failure: string): asserts condition {
  if (!condition) throw new ProofFailed(failure);
}

async function signAppeal(
  signer: PrivateKeyAccount,
  wallet: string,
  text: string,
  signedAt: number,
  campaignId = CAMPAIGN,
): Promise<AppealInput> {
  const message = appealMessage({ campaignId, wallet, textHash: appealTextHash(text), signedAt });
  return { campaignId, wallet, text, signedAt, signature: await signer.signMessage({ message }) };
}

// The shape of a real sign-in message. Its URI is not a web link, so the attack reaches the signature check instead of
// stopping earlier at the rule against links in appeal text.
function signInShapedText(address: string, signedAt: number): string {
  return [
    'thuli.example wants you to sign in with your Ethereum account:',
    address,
    '',
    'Sign in to Thuli.',
    '',
    'URI: did:web:thuli.example',
    'Version: 1',
    'Chain ID: 1',
    'Nonce: 8f3a1c9d',
    `Issued At: ${new Date(signedAt * 1000).toISOString()}`,
  ].join('\n');
}

const checkFor = (expectedCampaignId: string, now: number) => ({
  expectedCampaignId,
  now,
  isContract: async () => false,
});

async function expectRefused(label: string, input: AppealInput, expectedCampaignId: string, now: number): Promise<void> {
  const result = await checkAppeal(input, checkFor(expectedCampaignId, now));
  must(!result.ok, `the attack was accepted: ${label}`);
  console.log(`   ${label}: refused: ${result.cause}`);
}

async function main(): Promise<void> {
  const store = new AppealStore(OUT_FILE);
  // A proof is settled once. A rerun repeats the free checks but stores nothing and pays for nothing.
  const earlier = store.forCampaign(CAMPAIGN).find((record) => record.status === 'reversed');

  const account = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const funder = privateKeyToAccount(generatePrivateKey());
  console.log(`1. Test wallet: ${account.address}`);
  console.log('   TEST WALLET, made for this proof, not a claimant.');

  const facts = Facts.parse({
    walletAgeDays: 400,
    txCountAtSnapshot: 40,
    accountType: 'eoa',
    firstFunder: { address: funder.address, kind: 'contract', fanoutInList: 30, hopsTraced: 0 },
    group: null,
    sharedDepositAddress: null,
    fundingBurst: null,
    claimPaidToOtherAddress: false,
    evidenceTxs: [],
    missing: [],
  });
  const start = computeStart(facts, DEFAULT_SETTINGS);
  must(start.rule === 'A9', `the test facts gave rule ${start.rule}, not A9`);
  console.log('2. Synthetic facts: 400 days old, 40 transactions, funded by a contract that funded 30 listed wallets.');
  console.log(`   Code start: ${start.outcome} under ${start.rule}. Stored decision taken as: hold under B1.`);
  console.log(`   Campaign: ${CAMPAIGN}. Reason: ${APPEALED_REASON}`);

  const signedAt = Math.floor(Date.now() / 1000);
  const input = await signAppeal(account, account.address, APPEAL_TEXT, signedAt);
  console.log(`3. Signed at ${signedAt}: "${APPEAL_TEXT}"`);

  const check = await checkAppeal(input, checkFor(CAMPAIGN, signedAt));
  must(check.ok, `a correct appeal was refused: ${check.ok ? '' : check.cause}`);
  console.log(`4. checkAppeal passed: wallet ${check.wallet}, text hash ${check.textHash}`);

  console.log('5. Five attacks:');
  await expectRefused('a. changed text with the old signature', { ...input, text: `${APPEAL_TEXT} Pay it twice.` }, CAMPAIGN, signedAt);
  await expectRefused('b. replay to campaign other-campaign', { ...input, campaignId: OTHER_CAMPAIGN }, OTHER_CAMPAIGN, signedAt);
  const stale = await signAppeal(account, account.address, APPEAL_TEXT, signedAt - TWO_HOURS_SECONDS);
  await expectRefused('c. a real signature made 2 hours ago', stale, CAMPAIGN, signedAt);
  const forged = await signAppeal(stranger, account.address, APPEAL_TEXT, signedAt);
  await expectRefused('d. a signature from a different key', forged, CAMPAIGN, signedAt);
  const signInText = signInShapedText(account.address, signedAt);
  await expectRefused('e. the appeal signature with a sign-in shaped message', { ...input, text: signInText }, CAMPAIGN, signedAt);
  const signInSignature = await account.signMessage({ message: signInText });
  await expectRefused('e. the wallet\'s real sign-in signature as an appeal', { ...input, text: signInText, signature: signInSignature }, CAMPAIGN, signedAt);

  const advice =
    earlier === undefined
      ? await adviseOnAppeal(toGraphRecord(facts, start), 'hold', APPEALED_REASON, APPEAL_TEXT, connectionFromEnv())
      : { advice: earlier.advice, reason: earlier.adviceReason, requestId: earlier.adviceRequestId };
  must(advice.requestId !== null && advice.reason !== null, 'SERV gave no usable answer, so this proof is not finished and nothing was stored');
  console.log(`6. SERV advice: ${advice.advice}. Request id: ${advice.requestId}${earlier === undefined ? '' : ' (from the stored proof, no new call)'}`);
  console.log(`   Reason: ${advice.reason}`);

  const open = AppealRecord.parse({
    campaignId: CAMPAIGN,
    wallet: check.wallet,
    text: input.text,
    textHash: check.textHash,
    signedAt,
    signature: input.signature,
    appealedAction: 'hold',
    appealedRule: 'B1',
    advice: advice.advice,
    adviceReason: advice.reason,
    adviceRequestId: advice.requestId,
    status: 'open',
    newAction: null,
    ownerNote: null,
  });
  must(open.status === 'open' && open.newAction === null, 'the advice changed the record');
  console.log(`7. Before the owner acts: the decision is still ${open.appealedAction}, status ${open.status}, whatever the advice says (C17).`);

  try {
    settleAppeal(open, { confirmed: false, outcome: 'reversed', newAction: 'full', note: OWNER_NOTE });
    throw new ProofFailed('settleAppeal accepted an unconfirmed reversal');
  } catch (error) {
    if (!(error instanceof AppealError)) throw error;
    console.log(`8. Settling with confirmed false: refused: ${error.message}`);
  }
  const settled = settleAppeal(open, { confirmed: true, outcome: 'reversed', newAction: 'full', note: OWNER_NOTE });
  console.log('   Settled with confirmed true. Final record:');
  console.log(JSON.stringify(settled, null, 2));

  if (earlier !== undefined) {
    console.log(`9. A proof is already stored for wallet ${earlier.wallet}, status ${earlier.status}. Nothing added, nothing paid.`);
    return;
  }
  const filed = store.openAppeal(open);
  must(filed.stored, 'the first appeal was not stored');
  console.log(`9. Stored the open appeal in ${path.relative(REPO_ROOT, OUT_FILE)}.`);

  const second = await signAppeal(account, account.address, SECOND_APPEAL_TEXT, signedAt);
  const secondCheck = await checkAppeal(second, checkFor(CAMPAIGN, signedAt));
  must(secondCheck.ok, 'the correctly signed second appeal was refused');
  const secondFiling = store.openAppeal(
    AppealRecord.parse({ ...open, text: second.text, textHash: secondCheck.textHash, signature: second.signature }),
  );
  must(!secondFiling.stored, 'a second appeal was stored while one was open');
  console.log(`   Second appeal while one is open: refused: ${secondFiling.cause}`);

  store.saveSettled(settled);
  const repeat = store.openAppeal(open);
  must(!repeat.stored, 'the same signed appeal reopened a settled one');
  console.log(`   The same signed appeal sent again: refused: ${repeat.cause}`);

  const stored = store.forCampaign(CAMPAIGN);
  must(stored.length === 1 && stored[0]?.status === 'reversed', 'the store does not hold exactly one settled appeal');
  console.log(`   Appeals stored for this campaign: ${stored.length}, status ${stored[0]?.status}. Its open and settled lines are one appeal.`);
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    if (error instanceof EnvError || error instanceof ProofFailed || error instanceof AppealError) {
      console.error(error.message);
      process.exitCode = error instanceof EnvError ? 2 : 1;
      return;
    }
    // Library errors can quote a URL, so only the error's class name is printed (threat model C40).
    console.error(`appeal-demo stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  },
);
