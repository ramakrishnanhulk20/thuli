// Not covered here: a real Safe or delegated EOA on a fork (isContract is a stand-in, wired the way a caller must wire it),
// the route and store around an ask (whether the campaign is open, a second ask from one wallet, rate limits), a sign-in
// signature offered as an ask, because no sign-in message exists yet, and a signature's high-s twin, which viem accepts as
// a second spelling of one valid signature.
import { parseSignature, serializeCompactSignature, signatureToCompactSignature, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  AppealError,
  appealMessage,
  appealTextHash,
  ASK_WINDOW_SECONDS,
  askMessage,
  checkAppeal,
  checkAsk,
  parseAddress,
  type AskInput,
} from '../src/index.ts';

const NOW = 1_800_000_000;
const CAMPAIGN = 'campaign-one';
const OTHER_CAMPAIGN = 'campaign-two';
const APPEAL_TEXT = 'This wallet belongs to one person.';
const SIGNATURE_CAUSE = 'the signature does not match this ask';
const APPEAL_SIGNATURE_CAUSE = 'the signature does not match this appeal';
const CONTRACT_CAUSE = 'contract wallets cannot ask yet';
const UNCHECKED_CAUSE = 'the wallet type could not be checked';
const WALLET_CAUSE = 'the wallet is not a valid address';
// The EIP-55 example address, and the same address with the case of one letter flipped so its checksum is wrong.
const EIP55_EXAMPLE = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const MISTYPED = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

const asker = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

interface Signing {
  campaignId: string;
  signedAt: number;
  signer: PrivateKeyAccount;
}

/** A correctly signed ask from the asker, with any one thing changed. */
async function signed(overrides: Partial<Signing> = {}): Promise<AskInput> {
  const { campaignId, signedAt, signer }: Signing = { campaignId: CAMPAIGN, signedAt: NOW, signer: asker, ...overrides };
  const message = askMessage({ campaignId, wallet: asker.address, signedAt });
  return { campaignId, wallet: asker.address, signedAt, signature: await signer.signMessage({ message }) };
}

const context = (overrides: Partial<Parameters<typeof checkAsk>[1]> = {}) => ({
  expectedCampaignId: CAMPAIGN,
  now: NOW,
  isContract: async () => false,
  ...overrides,
});

const appealContext = { expectedCampaignId: CAMPAIGN, now: NOW, isContract: async () => false };
const refusedWith = (cause: string) => ({ ok: false, cause });
const accepted = { ok: true, wallet: asker.address };

describe('askMessage', () => {
  it('is exactly the four lines, with the wallet checksummed whatever spelling came in', () => {
    const message = askMessage({ campaignId: 'spring-drop_2026.v1', wallet: EIP55_EXAMPLE.toLowerCase(), signedAt: NOW });
    expect(message).toBe(
      'Thuli ask v1\nCampaign: spring-drop_2026.v1\nWallet: 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\nSigned at: 1800000000\n',
    );
  });

  it('throws the same kind of error appealMessage throws for the same bad id, wallet or time', () => {
    const good = { campaignId: CAMPAIGN, wallet: asker.address, signedAt: NOW };
    const appealGood = { ...good, textHash: appealTextHash(APPEAL_TEXT) };
    const errorName = (build: () => string): string => {
      try {
        build();
      } catch (error) {
        return (error as Error).name;
      }
      return 'no error';
    };
    const changes = [
      { campaignId: '' },
      { campaignId: 'a'.repeat(129) },
      { campaignId: 'a\nWallet: 0xabc' },
      { campaignId: 'two words' },
      { campaignId: 'a:b' },
      { wallet: 'not an address' },
      { wallet: MISTYPED },
      { signedAt: 1.5 },
      { signedAt: -1 },
      { signedAt: Number.NaN },
    ];
    for (const change of changes) {
      const asked = errorName(() => askMessage({ ...good, ...change }));
      expect([change, asked]).toEqual([change, errorName(() => appealMessage({ ...appealGood, ...change }))]);
      expect([change, asked]).not.toEqual([change, 'no error']);
    }
    expect(() => askMessage({ ...good, campaignId: [CAMPAIGN] as unknown as string })).toThrow(AppealError);
    expect(() => askMessage({ ...good, campaignId: 'a'.repeat(128), signedAt: 0 })).not.toThrow();
  });
});

describe('checkAsk', () => {
  it('returns one canonical wallet for the lowercase, checksummed and uppercase-hex spellings (C1)', async () => {
    const input = await signed();
    const spellings = [asker.address.toLowerCase(), asker.address, `0x${asker.address.slice(2).toUpperCase()}`];
    const results = [];
    for (const wallet of spellings) results.push(await checkAsk({ ...input, wallet }, context()));
    expect(results).toEqual([accepted, accepted, accepted]);
  });

  it('refuses a mixed-case address with a wrong checksum at the first check (C1)', async () => {
    expect(parseAddress(EIP55_EXAMPLE)).toBe(EIP55_EXAMPLE);
    expect(await checkAsk({ ...(await signed()), wallet: MISTYPED }, context())).toEqual(refusedWith(WALLET_CAUSE));
  });

  it('refuses a real appeal signature offered as an ask for the same campaign, wallet and time (C7)', async () => {
    const appeal = { campaignId: CAMPAIGN, wallet: asker.address, text: APPEAL_TEXT, signedAt: NOW };
    const message = appealMessage({ ...appeal, textHash: appealTextHash(APPEAL_TEXT) });
    const signature = await asker.signMessage({ message });
    expect((await checkAppeal({ ...appeal, signature }, appealContext)).ok).toBe(true);
    expect(await checkAsk({ ...(await signed()), signature }, context())).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('refuses a real ask signature offered as an appeal, with a plain appeal text or the ask text itself (C7)', async () => {
    const input = await signed();
    expect(await checkAsk(input, context())).toEqual(accepted);
    const askText = askMessage({ campaignId: CAMPAIGN, wallet: asker.address, signedAt: NOW });
    for (const text of [APPEAL_TEXT, askText]) {
      const appeal = { campaignId: CAMPAIGN, wallet: asker.address, text, signedAt: NOW, signature: input.signature };
      expect(await checkAppeal(appeal, appealContext)).toEqual(refusedWith(APPEAL_SIGNATURE_CAUSE));
    }
  });

  it('refuses an ask signed for campaign A when it is sent to campaign B (C7)', async () => {
    const input = await signed();
    const atB = context({ expectedCampaignId: OTHER_CAMPAIGN });
    expect(await checkAsk(input, atB)).toEqual(refusedWith('this ask is for a different campaign'));
    expect(await checkAsk({ ...input, campaignId: OTHER_CAMPAIGN }, atB)).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('allows a signature 600 seconds old and refuses one 601 seconds old, or any age against a broken clock', async () => {
    expect(ASK_WINDOW_SECONDS).toBe(600);
    expect(await checkAsk(await signed({ signedAt: NOW - 600 }), context())).toEqual(accepted);
    expect(await checkAsk(await signed({ signedAt: NOW - 601 }), context())).toEqual(refusedWith('the signature is too old'));
    expect(await checkAsk(await signed(), context({ now: Number.NaN }))).toEqual(refusedWith('the signature is too old'));
  });

  it('allows a signature dated 60 seconds ahead and refuses one 61 seconds ahead', async () => {
    expect(await checkAsk(await signed({ signedAt: NOW + 60 }), context())).toEqual(accepted);
    expect(await checkAsk(await signed({ signedAt: NOW + 61 }), context())).toEqual(
      refusedWith('the signature is dated in the future'),
    );
  });

  it('refuses a signing time that is not a whole number of seconds', async () => {
    const input = await signed();
    for (const signedAt of [NOW + 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await checkAsk({ ...input, signedAt }, context())).toEqual(
        refusedWith('the signing time is not a whole number of seconds'),
      );
    }
  });

  it('refuses a contract wallet with the one clear message (C9)', async () => {
    expect(await checkAsk(await signed(), context({ isContract: async () => true }))).toEqual(refusedWith(CONTRACT_CAUSE));
  });

  it('refuses when the account reader answers null or throws (C9)', async () => {
    const unknown = async () => null as unknown as boolean;
    const failing = async () => {
      throw new Error('rpc down');
    };
    expect(await checkAsk(await signed(), context({ isContract: unknown }))).toEqual(refusedWith(UNCHECKED_CAUSE));
    expect(await checkAsk(await signed(), context({ isContract: failing }))).toEqual(refusedWith(UNCHECKED_CAUSE));
  });

  it('refuses a signature from a key other than the wallet (C9)', async () => {
    expect(await checkAsk(await signed({ signer: stranger }), context())).toEqual(refusedWith(SIGNATURE_CAUSE));
  });

  it('refuses a signature with its last byte flipped (C9)', async () => {
    const input = await signed();
    const last = Number.parseInt(input.signature.slice(-2), 16);
    expect([27, 28]).toContain(last);
    for (const flipped of [last ^ 0xff, last === 27 ? 28 : 27]) {
      const signature = `${input.signature.slice(0, -2)}${flipped.toString(16).padStart(2, '0')}`;
      expect(await checkAsk({ ...input, signature }, context())).toEqual(refusedWith(SIGNATURE_CAUSE));
    }
  });

  it('refuses a 64-byte or non-hex signature without throwing (C9)', async () => {
    const input = await signed();
    const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(input.signature as Hex)));
    expect(compact).toHaveLength(2 + 128);
    const shapes = [compact, input.signature.slice(0, 130), `0x${'zz'.repeat(65)}`, input.signature.slice(2), `0X${input.signature.slice(2)}`];
    for (const signature of shapes) {
      await expect(checkAsk({ ...input, signature }, context())).resolves.toEqual(refusedWith(SIGNATURE_CAUSE));
    }
  });

  it('reports the earlier cause when an ask is wrong in two ways, and reads the account type only after the free checks', async () => {
    let reads = 0;
    const contractWallet = async () => {
      reads += 1;
      return true;
    };
    const walletAndCampaign = { ...(await signed()), wallet: MISTYPED, campaignId: OTHER_CAMPAIGN };
    expect(await checkAsk(walletAndCampaign, context())).toEqual(refusedWith(WALLET_CAUSE));

    const staleContract = await checkAsk(await signed({ signedAt: NOW - 601 }), context({ isContract: contractWallet }));
    expect(staleContract).toEqual(refusedWith('the signature is too old'));
    expect(reads).toBe(0);

    const contractStranger = await checkAsk(await signed({ signer: stranger }), context({ isContract: contractWallet }));
    expect(contractStranger).toEqual(refusedWith(CONTRACT_CAUSE));
    expect(reads).toBe(1);
  });

  it('never throws, whatever type each field or the whole input arrives as', async () => {
    const input = await signed();
    const wrongTypes: unknown[] = [undefined, null, 7, 1n, true, {}, [], [input.wallet], () => input.wallet];
    const outcome = (value: unknown) =>
      checkAsk(value as AskInput, context()).then(
        (result) => (result.ok ? 'passed' : 'refused'),
        () => 'threw',
      );
    const notRefused: string[] = [];
    for (const field of ['campaignId', 'wallet', 'signedAt', 'signature'] as const) {
      for (const [index, value] of wrongTypes.entries()) {
        const result = await outcome({ ...input, [field]: value });
        if (result !== 'refused') notRefused.push(`${field} #${index}: ${result}`);
      }
    }
    for (const [index, whole] of [null, undefined, 'ask', 42].entries()) {
      const result = await outcome(whole);
      if (result !== 'refused') notRefused.push(`whole input #${index}: ${result}`);
    }
    expect(notRefused).toEqual([]);
  });
});
