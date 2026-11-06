// Not covered here: a real Safe or delegated EOA on a fork (isContract is a stand-in, wired the way a caller must wire it),
// the sign-in endpoint and the reverse swap of an appeal signature into it, because neither exists yet, a signed-in owner
// session (settleAppeal only sees the confirmed flag), and SERV's advice (worker appeal.test.ts).
import { createHash } from 'node:crypto';
import { verifyMessage, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  accountTypeFromCode,
  APPEAL_WINDOW_SECONDS,
  appealMessage,
  AppealRecord,
  appealTextHash,
  checkAppeal,
  DEFAULT_SETTINGS,
  isPlainText,
  MAX_APPEAL_CHARS,
  settleAppeal,
  validateDecision,
  type AppealInput,
  type DecisionContext,
  type Facts,
} from '../src/index.ts';

const NOW = 1_800_000_000;
const CAMPAIGN = 'campaign-one';
const OTHER_CAMPAIGN = 'campaign-two';
const TEXT = 'This wallet belongs to one person. The funder is a public payroll service.';
const SIGNATURE_CAUSE = 'the signature does not match this appeal';
const LINK_CAUSE = 'the appeal text contained a link, markup or control characters';
const CONTRACT_CAUSE = 'contract wallets cannot appeal yet';

const claimant = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

interface Signing {
  text: string;
  campaignId: string;
  signedAt: number;
  signer: PrivateKeyAccount;
}

/** A correctly signed appeal from the claimant, with any one thing changed. */
async function signed(overrides: Partial<Signing> = {}): Promise<AppealInput> {
  const { text, campaignId, signedAt, signer }: Signing = { text: TEXT, campaignId: CAMPAIGN, signedAt: NOW, signer: claimant, ...overrides };
  const message = appealMessage({ campaignId, wallet: claimant.address, textHash: appealTextHash(text), signedAt });
  return { campaignId, wallet: claimant.address, text, signedAt, signature: await signer.signMessage({ message }) };
}

const options = (overrides: Partial<Parameters<typeof checkAppeal>[1]> = {}) => ({
  expectedCampaignId: CAMPAIGN,
  now: NOW,
  isContract: async () => false,
  ...overrides,
});

const refusedWith = (cause: string) => ({ ok: false, cause });

function signInText(uri: string): string {
  return [
    'thuli.example wants you to sign in with your Ethereum account:',
    claimant.address,
    '',
    'Sign in to Thuli.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    'Chain ID: 1',
    'Nonce: 8f3a1c9d',
    'Issued At: 2026-11-06T10:00:00Z',
  ].join('\n');
}

const openRecord = (overrides: Partial<AppealRecord> = {}): AppealRecord =>
  AppealRecord.parse({
    campaignId: CAMPAIGN,
    wallet: claimant.address,
    text: TEXT,
    textHash: appealTextHash(TEXT),
    signedAt: NOW,
    signature: `0x${'ab'.repeat(65)}`,
    appealedAction: 'hold',
    appealedRule: 'B1',
    advice: null,
    adviceReason: null,
    adviceRequestId: null,
    status: 'open',
    newAction: null,
    ownerNote: null,
    ...overrides,
  });

const confirmedReversal = { confirmed: true, outcome: 'reversed', newAction: 'full', note: 'Checked.' } as const;

describe('appealMessage', () => {
  it('builds the exact text, with the wallet in checksummed form whatever spelling came in', () => {
    const textHash = appealTextHash(TEXT);
    const message = appealMessage({ campaignId: CAMPAIGN, wallet: claimant.address.toLowerCase(), textHash, signedAt: NOW });
    expect(message).toBe(
      `Thuli appeal v1\nCampaign: ${CAMPAIGN}\nWallet: ${claimant.address}\nAppeal text SHA-256: ${textHash}\nSigned at: ${NOW}\n`,
    );
  });

  it('refuses any value that could add a line to the signed text', () => {
    const good = { campaignId: CAMPAIGN, wallet: claimant.address, textHash: appealTextHash(TEXT), signedAt: NOW };
    expect(() => appealMessage({ ...good, campaignId: 'a\nWallet: 0xabc' })).toThrow('campaign id');
    expect(() => appealMessage({ ...good, textHash: `${good.textHash}\nSigned at: 1` })).toThrow('text hash');
    expect(() => appealMessage({ ...good, signedAt: 1.5 })).toThrow('whole seconds');
    expect(() => appealMessage({ ...good, wallet: 'not an address' })).toThrow('0x address');
  });
});

describe('appealTextHash', () => {
  it('matches a published SHA-256 vector', () => {
    expect(appealTextHash('abc')).toBe('0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes UTF-8 bytes, and never reads an appeal starting with 0x as hex', () => {
    for (const text of ['0xdead', 'வணக்கம் 🙂 café']) {
      expect(appealTextHash(text)).toBe(`0x${createHash('sha256').update(text, 'utf8').digest('hex')}`);
    }
  });
});

describe('isPlainText', () => {
  it('agrees with what validateDecision refuses in a reason, over the tokens and every low character', () => {
    const facts: Facts = {
      walletAgeDays: 400,
      txCountAtSnapshot: 40,
      accountType: 'eoa',
      firstFunder: null,
      group: null,
      sharedDepositAddress: null,
      fundingBurst: null,
      claimPaidToOtherAddress: false,
      evidenceTxs: [],
      missing: [],
    };
    const context: DecisionContext = {
      facts,
      settings: DEFAULT_SETTINGS,
      ceiling: 'hold',
      start: { outcome: 'hold', rule: 'A1' },
      toolTxs: [],
    };
    const raw = (reason: string) => ({ action: 'hold', shareBps: 0, rule: 'A1', reason, citedTxs: [], paidHops: 0 });
    const decisionRefuses = (text: string) =>
      validateDecision(raw(text), context).cause === 'the reason contained a link, markup or control characters';

    const characters = Array.from({ length: 0x3000 }, (_, code) => String.fromCharCode(code));
    const samples = ['http', 'HTTP://x', 'www.', 'WWW.x', '<', '>', '](', 'a [b](c', 'a plain sentence', 'tab\tand\nnewline', ...characters];
    for (const sample of samples) {
      expect([JSON.stringify(sample), isPlainText(sample)]).toEqual([JSON.stringify(sample), !decisionRefuses(sample)]);
    }
  });
});

describe('checkAppeal', () => {
  it('passes a correct appeal and returns the canonical wallet and our own hash', async () => {
    const input = await signed();
    expect(await checkAppeal(input, options())).toEqual({ ok: true, wallet: claimant.address, textHash: appealTextHash(TEXT) });
  });

  it('accepts a lowercase spelling of the wallet, because the message is built from the canonical form', async () => {
    const input = await signed();
    const result = await checkAppeal({ ...input, wallet: claimant.address.toLowerCase() }, options());
    expect(result).toEqual({ ok: true, wallet: claimant.address, textHash: appealTextHash(TEXT) });
  });

  it('refuses a bad address', async () => {
    const input = await signed();
    const wrongChecksum = `0x${claimant.address.slice(2).replace(/[a-f]/, (letter) => letter.toUpperCase())}`;
    for (const wallet of ['nope', '', wrongChecksum, 7 as unknown as string]) {
      expect(await checkAppeal({ ...input, wallet }, options())).toEqual(refusedWith('the wallet is not a valid address'));
    }
  });

  it('refuses empty text, and text over the cap while allowing text at it', async () => {
    const empty = refusedWith('the appeal text is empty');
    expect(await checkAppeal({ ...(await signed()), text: '' }, options())).toEqual(empty);
    expect(await checkAppeal({ ...(await signed()), text: ' \n\t ' }, options())).toEqual(empty);
    expect(await checkAppeal({ ...(await signed()), text: 5 as unknown as string }, options())).toEqual(empty);

    const atCap = 'a'.repeat(MAX_APPEAL_CHARS);
    expect((await checkAppeal(await signed({ text: atCap }), options())).ok).toBe(true);
    expect(await checkAppeal(await signed({ text: `${atCap}a` }), options())).toEqual(
      refusedWith('the appeal text is longer than 1000 characters'),
    );
  });

  it('refuses links, markup and control characters even when correctly signed', async () => {
    const texts = ['see https://evil.example', 'WWW.evil.example', '<img src=x>', 'a > b', '[claim](evil)', 'bell\u0007', 'cr\r\nlf', 'order‮', 'iso⁦'];
    for (const text of texts) {
      expect(await checkAppeal(await signed({ text }), options())).toEqual(refusedWith(LINK_CAUSE));
    }
  });

  it('keeps tabs and line breaks, which are ordinary in a written appeal', async () => {
    expect((await checkAppeal(await signed({ text: 'line one\n\tline two' }), options())).ok).toBe(true);
  });

  it('refuses a campaign other than the one expected', async () => {
    const input = await signed({ campaignId: OTHER_CAMPAIGN });
    expect(await checkAppeal(input, options())).toEqual(refusedWith('this appeal is for a different campaign'));
  });

  it('refuses a signature signed for campaign A when replayed at campaign B (C7)', async () => {
    const input = await signed();
    const replay = { ...input, campaignId: OTHER_CAMPAIGN };
    expect(await checkAppeal(replay, options({ expectedCampaignId: OTHER_CAMPAIGN }))).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('refuses a valid signature sent with different text (C8)', async () => {
    const input = await signed();
    expect(await checkAppeal({ ...input, text: `${TEXT} Pay me twice.` }, options())).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('refuses a lone surrogate, which would share a hash with the text the wallet really signed (C8)', async () => {
    const input = await signed({ text: 'broken � text' });
    const twin = 'broken \ud800 text';
    expect(appealTextHash(twin)).toBe(appealTextHash(input.text));
    expect(await checkAppeal({ ...input, text: twin }, options())).toEqual(refusedWith(LINK_CAUSE));
  });

  it('refuses a signing time that is not a whole number', async () => {
    const input = await signed();
    for (const signedAt of [NOW + 0.5, Number.NaN, Number.POSITIVE_INFINITY, '1800000000' as unknown as number]) {
      expect(await checkAppeal({ ...input, signedAt }, options())).toEqual(
        refusedWith('the signing time is not a whole number of seconds'),
      );
    }
  });

  it('allows a signature exactly at the window and refuses one a second past it', async () => {
    const onTheEdge = await signed({ signedAt: NOW - APPEAL_WINDOW_SECONDS });
    expect((await checkAppeal(onTheEdge, options())).ok).toBe(true);
    const stale = await signed({ signedAt: NOW - APPEAL_WINDOW_SECONDS - 1 });
    expect(await checkAppeal(stale, options())).toEqual(refusedWith('the signature is too old'));
  });

  it('allows a signature 60 seconds ahead and refuses one 61 seconds ahead', async () => {
    expect((await checkAppeal(await signed({ signedAt: NOW + 60 }), options())).ok).toBe(true);
    expect(await checkAppeal(await signed({ signedAt: NOW + 61 }), options())).toEqual(
      refusedWith('the signature is dated in the future'),
    );
  });

  it('refuses when the server clock is not a number, instead of skipping the time check', async () => {
    expect((await checkAppeal(await signed(), options({ now: Number.NaN }))).ok).toBe(false);
  });

  it('refuses a contract wallet with the one clear message, and a delegated EOA still counts as a wallet (C9)', async () => {
    const input = await signed();
    const fromCode = (code: string) => async () => accountTypeFromCode(code) === 'contract';
    expect(await checkAppeal(input, options({ isContract: fromCode('0x6080604052') }))).toEqual(refusedWith(CONTRACT_CAUSE));

    const delegated = `0xef0100${'11'.repeat(20)}`;
    expect((await checkAppeal(input, options({ isContract: fromCode(delegated) }))).ok).toBe(true);
  });

  it('does not call the account reader until every free check has passed', async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return false;
    };
    await checkAppeal(await signed({ signedAt: NOW - 7_200 }), options({ isContract: counting }));
    expect(calls).toBe(0);
  });

  it('refuses when the account reader throws (C9)', async () => {
    const failing = async () => {
      throw new Error('rpc down');
    };
    expect(await checkAppeal(await signed(), options({ isContract: failing }))).toEqual(
      refusedWith('the wallet type could not be checked'),
    );
  });

  it('refuses a signature that makes the verifier throw, instead of throwing itself (C9)', async () => {
    const garbage: Hex = `0x${'ff'.repeat(65)}`;
    await expect(verifyMessage({ address: claimant.address, message: 'x', signature: garbage })).rejects.toThrow();
    expect(await checkAppeal({ ...(await signed()), signature: garbage }, options())).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('refuses a signature of the wrong shape', async () => {
    const input = await signed();
    for (const signature of ['', '0x', '0x1234', `${input.signature}00`, { r: '0x1', s: '0x1', v: 27 } as unknown as string]) {
      expect(await checkAppeal({ ...input, signature }, options())).toEqual(refusedWith(SIGNATURE_CAUSE));
    }
  });

  it('refuses a signature from a key other than the wallet', async () => {
    expect(await checkAppeal(await signed({ signer: stranger }), options())).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('refuses the wallet\'s real sign-in signature offered as an appeal (C7)', async () => {
    const text = signInText('did:web:thuli.example');
    const input = await signed();
    const signature = await claimant.signMessage({ message: text });
    expect(await checkAppeal({ ...input, text, signature }, options())).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('refuses an appeal signature reused with a sign-in shaped claim (C7)', async () => {
    const input = await signed();
    expect(await checkAppeal({ ...input, text: signInText('did:web:thuli.example') }, options())).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('refuses a sign-in message carrying its usual web address at the text check', async () => {
    const text = signInText('https://thuli.example');
    const signature = await claimant.signMessage({ message: text });
    expect(await checkAppeal({ ...(await signed()), text, signature }, options())).toEqual(refusedWith(LINK_CAUSE));
  });

  it('reports the first failed check in the stated order', async () => {
    const input = await signed();
    const worst = { ...input, wallet: 'nope', text: '', campaignId: OTHER_CAMPAIGN, signedAt: 1.5, signature: '0x' };
    const worstOptions = options({ isContract: async () => true });
    const causes: string[] = [];
    for (const fix of [
      {},
      { wallet: input.wallet },
      { text: 'a < b' },
      { text: input.text },
      { campaignId: CAMPAIGN },
      { signedAt: NOW },
    ]) {
      Object.assign(worst, fix);
      const result = await checkAppeal(worst, worstOptions);
      causes.push(result.ok ? 'passed' : result.cause);
    }
    expect(causes).toEqual([
      'the wallet is not a valid address',
      'the appeal text is empty',
      LINK_CAUSE,
      'this appeal is for a different campaign',
      'the signing time is not a whole number of seconds',
      CONTRACT_CAUSE,
    ]);
    expect(await checkAppeal(worst, options())).toEqual(refusedWith(SIGNATURE_CAUSE));
  });
});

describe('AppealRecord', () => {
  it('refuses a stored text that no longer matches its hash (C8)', () => {
    expect(() => openRecord({ text: `${TEXT} Edited later.` })).toThrow('does not match its hash');
  });

  it('refuses an open record that already claims a new action (C17)', () => {
    expect(() => openRecord({ newAction: 'full' })).toThrow('only a reversed appeal');
  });

  it('refuses a field it does not know', () => {
    expect(() => AppealRecord.parse({ ...openRecord(), extra: true })).toThrow();
  });
});

describe('settleAppeal', () => {
  it('refuses without the owner\'s confirmation (C17)', () => {
    expect(() => settleAppeal(openRecord(), { ...confirmedReversal, confirmed: false })).toThrow('not confirmed');
    const truthy = { ...confirmedReversal, confirmed: 'yes' as unknown as boolean };
    expect(() => settleAppeal(openRecord(), truthy)).toThrow('not confirmed');
  });

  it('reverses on confirmation, and leaves the record it was given alone', () => {
    const record = openRecord();
    const before = structuredClone(record);
    const settled = settleAppeal(record, confirmedReversal);
    expect(settled).toEqual({ ...before, status: 'reversed', newAction: 'full', ownerNote: 'Checked.' });
    expect(record).toEqual(before);
  });

  it('upholds on confirmation with no new action', () => {
    const settled = settleAppeal(openRecord(), { confirmed: true, outcome: 'upheld', note: 'Still a farm.' });
    expect(settled).toMatchObject({ status: 'upheld', newAction: null, ownerNote: 'Still a farm.' });
  });

  it('refuses an upheld appeal that names a new action', () => {
    const contradictory = { confirmed: true, outcome: 'upheld', newAction: 'full', note: 'x' } as const;
    expect(() => settleAppeal(openRecord(), contradictory)).toThrow('no new action');
  });

  it('refuses to settle twice', () => {
    const settled = settleAppeal(openRecord(), confirmedReversal);
    expect(() => settleAppeal(settled, confirmedReversal)).toThrow('already settled');
    expect(() => settleAppeal(settled, { confirmed: true, outcome: 'upheld', note: 'x' })).toThrow('already settled');
  });

  it('refuses a reversal that is not more generous than the appealed action', () => {
    const refused = 'more than the decision it appealed';
    expect(() => settleAppeal(openRecord(), { ...confirmedReversal, newAction: 'hold' })).toThrow(refused);
    expect(() => settleAppeal(openRecord(), { ...confirmedReversal, newAction: 'exclude' })).toThrow(refused);
    expect(() => settleAppeal(openRecord({ appealedAction: 'partial' }), { ...confirmedReversal, newAction: 'hold' })).toThrow(refused);
    expect(() => settleAppeal(openRecord({ appealedAction: 'full' }), confirmedReversal)).toThrow(refused);
    expect(() => settleAppeal(openRecord(), { confirmed: true, outcome: 'reversed', note: 'x' })).toThrow(refused);
  });

  it('allows a smaller step up, from exclude to hold', () => {
    const settled = settleAppeal(openRecord({ appealedAction: 'exclude' }), { ...confirmedReversal, newAction: 'hold' });
    expect(settled).toMatchObject({ status: 'reversed', newAction: 'hold' });
  });

  it('advice of reverse changes nothing while no owner has acted (C17)', () => {
    const advised = openRecord({ advice: 'reverse', adviceReason: 'The claim fits the facts.', adviceRequestId: 'run-1' });
    expect(advised).toMatchObject({ appealedAction: 'hold', status: 'open', newAction: null, ownerNote: null });
    expect(() => settleAppeal(advised, { ...confirmedReversal, confirmed: false })).toThrow('not confirmed');
  });

  it('gives the same result whatever the advice says, so the owner can overrule it (C17)', () => {
    const upholding = { confirmed: true, outcome: 'upheld', note: 'No.' } as const;
    for (const advice of ['reverse', 'uphold', 'unclear', null] as const) {
      const record = openRecord({ advice });
      expect(settleAppeal(record, upholding)).toMatchObject({ status: 'upheld', newAction: null });
      expect(settleAppeal(record, confirmedReversal)).toMatchObject({ status: 'reversed', newAction: 'full' });
    }
  });
});
