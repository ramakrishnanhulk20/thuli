// Covers the attack page's maths and its filing of answers: the ABI against the worker's, the leaf, the mistyped address,
// the status of one answer of each kind, and the bodies the API rows send. It does not call the chain or the site, and it
// does not cover the drawing; the browser script runs the real attacks.
import fs from 'node:fs';
import path from 'node:path';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  apiAttacks,
  answerText,
  classifyApiAnswer,
  classifyVaultError,
  describeRevert,
  hasValidChecksum,
  judgeRenderedReason,
  leafFor,
  MARKUP_REASON,
  mistypedAddress,
  readActiveRoot,
  rebuiltLeaf,
  rootLineState,
  rootLineText,
  rootMatches,
  runApiAttack,
  shortHash,
  STATE_SIGNATURE,
  runVaultCall,
  shortenAddresses,
  vaultCalls,
  type ProofFacts,
} from '../lib/attacks';
import { VAULT_ABI, VAULT_SIGNATURES } from '../lib/vaultAbi';
import { loadVaultProof } from '../lib/vaultProof';

const contracts = path.join(import.meta.dirname, '..', '..', 'contracts', 'deployments');
const record = loadVaultProof(path.join(contracts, 'base-sepolia-proof.json'));
const facts: ProofFacts = {
  chainId: record.chainId,
  vault: record.vault,
  token: record.token,
  owner: record.owner,
  agent: record.agent,
  root: record.root,
  perWalletCap: record.perWalletCap,
  paidAccount: record.paid.account,
  paidAmount: record.paid.amount,
  refusedAccount: record.refused.account,
  explorer: record.explorer,
};

describe('lib/vaultAbi.ts against the worker ABI', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'worker', 'src', 'vault', 'abi.ts'), 'utf8');
  const start = source.indexOf('[', source.indexOf('export const VAULT_ABI'));
  const end = source.indexOf('] as const', start);
  const generated = JSON.parse(source.slice(start, end + 1)) as { type: string; name?: string; inputs?: { type: string }[]; outputs?: { type: string }[]; stateMutability?: string }[];

  it('read the generated file as an array of ABI items', () => {
    expect(generated.length).toBeGreaterThan(20);
  });

  for (const signature of VAULT_SIGNATURES) {
    const parts = /^(function|error) (\w+)\((.*?)\)(?: (view))?(?: returns \((.*)\))?$/.exec(signature);
    it(`${signature} appears there with the same parameter types`, () => {
      expect(parts).not.toBeNull();
      const [, kind, name, params, mutability, returns] = parts as RegExpExecArray;
      const types = (list: string | undefined) => (list ?? '').split(',').map((entry) => entry.trim().split(/\s+/)[0] as string).filter((entry) => entry !== '');
      const item = generated.find((entry) => entry.type === kind && entry.name === name);
      expect(item, `${name} is missing from the worker ABI`).toBeDefined();
      expect((item?.inputs ?? []).map((input) => input.type)).toEqual(types(params));
      if (kind === 'function') {
        expect((item?.outputs ?? []).map((output) => output.type)).toEqual(types(returns));
        expect(item?.stateMutability === 'view').toBe(mutability === 'view');
      }
    });
  }

  it('parses into the ABI the page uses, one item per signature', () => {
    expect(VAULT_ABI).toHaveLength(VAULT_SIGNATURES.length);
  });

  it('state() in lib/attacks.ts has the same twelve fields, names and types in order, as the worker ABI', () => {
    const item = generated.find((entry) => entry.type === 'function' && entry.name === 'state') as
      | { inputs: unknown[]; stateMutability: string; outputs: { type: string; components: { name: string; type: string }[] }[] }
      | undefined;
    expect(item, 'state is missing from the worker ABI').toBeDefined();
    expect(item?.inputs).toEqual([]);
    expect(item?.stateMutability).toBe('view');
    expect(item?.outputs).toHaveLength(1);
    expect(item?.outputs[0]?.type).toBe('tuple');
    const fields = /returns \(\((.*)\) \w+\)$/.exec(STATE_SIGNATURE)?.[1]?.split(', ').map((entry) => entry.split(' ')) ?? [];
    expect(fields).toHaveLength(12);
    expect(fields.map(([type, name]) => ({ type, name }))).toEqual(item?.outputs[0]?.components.map(({ name, type }) => ({ type, name })));
    expect(fields.map(([, name]) => name)).toContain('activeRoot');
  });
});

describe('the list root', () => {
  it('rebuilt from the record equals the record root', () => {
    const leaf = leafFor(record.chainId, record.vault, record.paid.account, BigInt(record.paid.amount));
    expect(leaf.toLowerCase()).toBe(record.root.toLowerCase());
    expect(rootMatches(facts)).toBe(true);
  });

  it('does not match when any one input changes', () => {
    expect(rootMatches({ ...facts, paidAmount: String(BigInt(facts.paidAmount) + 1n) })).toBe(false);
    expect(rootMatches({ ...facts, paidAccount: facts.refusedAccount })).toBe(false);
    expect(rootMatches({ ...facts, vault: facts.token })).toBe(false);
    expect(rootMatches({ ...facts, chainId: 8453 })).toBe(false);
  });
});

describe('the root line', () => {
  const leaf = rebuiltLeaf(facts);
  const other = `0x${'ab'.repeat(32)}`;

  it('rebuilds the same leaf the record holds', () => {
    expect(leaf.toLowerCase()).toBe(record.root.toLowerCase());
  });

  it('says it is reading until the vault answers', () => {
    const line = rootLineState(leaf, { status: 'reading' }, record.root);
    expect(line).toEqual({ kind: 'reading' });
    expect(rootLineText(line)).toBe("READING THE VAULT'S ACTIVE ROOT");
  });

  it('says it matches when the rebuilt leaf is the live active root, with the first 10 and last 6 characters', () => {
    const line = rootLineState(leaf, { status: 'read', root: leaf }, record.root);
    expect(line).toEqual({ kind: 'match', root: leaf });
    expect(rootLineText(line)).toBe(`LIST ROOT REBUILT IN YOUR BROWSER MATCHES THE VAULT'S ACTIVE ROOT ${leaf.slice(0, 10)}…${leaf.slice(-6)}`);
    expect(rootLineState(leaf, { status: 'read', root: leaf.toUpperCase().replace('0X', '0x') }, record.root).kind).toBe('match');
  });

  it('says it could not read the vault, and keeps the rows on', () => {
    const line = rootLineState(leaf, { status: 'failed' }, record.root);
    expect(line).toEqual({ kind: 'unreadable' });
    expect(rootLineText(line)).toBe('COULD NOT READ THE VAULT. THE ROWS BELOW MAY NOT RUN.');
  });

  it('is a mismatch when the live root differs, and shows the live root', () => {
    const line = rootLineState(leaf, { status: 'read', root: other }, record.root);
    expect(line).toEqual({ kind: 'mismatch', root: other });
    expect(rootLineText(line)).toBe(`LIST ROOT REBUILT IN YOUR BROWSER: DOES NOT MATCH ${other.slice(0, 10)}…${other.slice(-6)}`);
  });

  it('is a mismatch when the record root differs, whatever the vault says, even before it is read', () => {
    for (const live of [{ status: 'reading' }, { status: 'failed' }, { status: 'read', root: leaf }] as const) {
      expect(rootLineState(leaf, live, other)).toEqual({ kind: 'mismatch', root: other });
    }
  });

  it('reads activeRoot from state() on the vault and files a bad read as failed', async () => {
    const calls: unknown[] = [];
    const reader = (answer: () => unknown) => ({
      readContract: async (parameters: never) => {
        calls.push(parameters);
        return answer();
      },
    });
    const good = await readActiveRoot(reader(() => ({ activeRoot: leaf, pendingRoot: other })), facts.vault);
    expect(good).toEqual({ status: 'read', root: leaf });
    expect(calls[0]).toMatchObject({ address: facts.vault, functionName: 'state' });
    expect(await readActiveRoot(reader(() => { throw new Error('offline'); }), facts.vault)).toEqual({ status: 'failed' });
    expect(await readActiveRoot(reader(() => ({ activeRoot: '0x12' })), facts.vault)).toEqual({ status: 'failed' });
    expect(await readActiveRoot(reader(() => null), facts.vault)).toEqual({ status: 'failed' });
    expect(await readActiveRoot(reader(() => 7), facts.vault)).toEqual({ status: 'failed' });
  });
});

describe('the mistyped address of row 6', () => {
  const wrong = mistypedAddress(record.paid.account);

  it('differs from the real address only in letter case', () => {
    expect(wrong).not.toBe(record.paid.account);
    expect(wrong.toLowerCase()).toBe(record.paid.account.toLowerCase());
    let changed = 0;
    for (let index = 0; index < wrong.length; index += 1) if (wrong[index] !== record.paid.account[index]) changed += 1;
    expect(changed).toBe(1);
  });

  it('fails the checksum while its lowercase form is the same address', () => {
    expect(hasValidChecksum(record.paid.account)).toBe(true);
    expect(hasValidChecksum(wrong)).toBe(false);
    expect(getAddress(wrong.toLowerCase())).toBe(record.paid.account);
  });

  it('refuses an address with no letter to flip', () => {
    expect(() => mistypedAddress(`0x${'1'.repeat(40)}`)).toThrow(RangeError);
  });
});

describe('what the vault calls send', () => {
  const calls = vaultCalls(facts);
  const amount = BigInt(facts.paidAmount);

  it('follows the five attacks in order', () => {
    expect(calls.claimOther).toEqual({ functionName: 'claim', args: [facts.refusedAccount, amount, []], from: facts.refusedAccount });
    expect(calls.claimTwice).toEqual({ functionName: 'claim', args: [facts.paidAccount, amount, []], from: facts.paidAccount });
    expect(calls.claimMore.args).toEqual([facts.paidAccount, 2n * amount, []]);
    expect(calls.withdraw).toEqual({ functionName: 'withdrawAfterEnd', args: [facts.agent], from: facts.agent });
    expect(calls.postRoot.from).toBe('0x000000000000000000000000000000000000dEaD');
    expect(calls.postRoot.args).toEqual([leafFor(facts.chainId, facts.vault, '0x000000000000000000000000000000000000dEaD', amount), amount]);
  });
});

describe('filing a vault answer', () => {
  const asRevert = (errorName: string, args: unknown[] = []) => {
    const data = encodeErrorResult({ abi: VAULT_ABI, errorName, args } as never);
    const reverted = new ContractFunctionRevertedError({ abi: VAULT_ABI, data, functionName: 'claim' });
    return new ContractFunctionExecutionError(reverted, { abi: VAULT_ABI, functionName: 'claim', args: [], sender: facts.refusedAccount as `0x${string}` });
  };

  it('a revert with a known error is refused, named with its arguments, addresses shortened', () => {
    expect(classifyVaultError(asRevert('InvalidProof'))).toEqual({ status: 'refused', answer: 'InvalidProof()', note: null });
    const twice = classifyVaultError(asRevert('NothingToClaim', [facts.paidAccount]));
    expect(twice.status).toBe('refused');
    expect(twice.answer).toBe(`NothingToClaim(${facts.paidAccount.slice(0, 6)}…${facts.paidAccount.slice(-4)})`);
    expect(twice.answer).toContain('0xFE2B…5CdD');
  });

  it('adds the note for a campaign that has ended or a vault that is paused, and still refuses', () => {
    const ended = classifyVaultError(asRevert('CampaignEnded'));
    expect(ended.status).toBe('refused');
    expect(ended.note).toBe("The proof vault's campaign has ended, so the vault refuses every claim.");
    expect(classifyVaultError(asRevert('EnforcedPause')).note).toBe('The proof vault is paused, so the vault refuses every claim.');
  });

  it('a failure that is not a revert could not run', () => {
    expect(classifyVaultError(new TypeError('Failed to fetch')).status).toBe('could-not-run');
    expect(classifyVaultError(Object.assign(new Error('call failed'), { cause: new Error('HTTP request failed') })).status).toBe('could-not-run');
    expect(classifyVaultError('text')).toEqual({ status: 'could-not-run', answer: '', note: null });
  });

  it('a simulation that returns is not refused, and the time is the difference of the clock', async () => {
    let tick = 100;
    const now = () => (tick += 40);
    const returned = await runVaultCall(async () => ({ result: [] }), now);
    expect(returned).toEqual({ status: 'not-refused', answer: '', note: null, ms: 40, target: 'chain' });
    const threw = await runVaultCall(async () => {
      throw asRevert('InvalidProof');
    }, now);
    expect(threw.status).toBe('refused');
    expect(threw.ms).toBe(40);
    expect(threw.target).toBe('chain');
    const lost = await runVaultCall(async () => {
      throw new TypeError('Failed to fetch');
    }, now);
    expect(lost.status).toBe('could-not-run');
  });

  it('writes errors and addresses plainly', () => {
    expect(describeRevert('InvalidProof', undefined)).toBe('InvalidProof()');
    expect(describeRevert('DepositExhausted', [5n, 3n])).toBe('DepositExhausted(5, 3)');
    expect(shortenAddresses(`${facts.paidAccount} and ${facts.agent}`)).toBe('0xFE2B…5CdD and 0xBedc…Dee6');
  });
});

describe('filing an API answer', () => {
  it('a status the attack expected is refused, shown with the status and the body text', () => {
    expect(classifyApiAnswer(400, { error: 'wallet rejected: address has a bad checksum' }, [400], 12)).toEqual({
      status: 'refused',
      answer: '400 wallet rejected: address has a bad checksum',
      note: null,
      ms: 12,
      target: 'site',
    });
    expect(classifyApiAnswer(402, { x402Version: 2, error: 'Payment required' }, [402], 9).answer).toBe('402 Payment required');
    expect(classifyApiAnswer(413, { error: 'the body is too large' }, [413, 400], 3).answer).toBe('413 the body is too large');
  });

  it("a 429 is the route refusing this caller, for any attack, with the limit's own words", () => {
    for (const expected of [[400], [402], [402, 400], [413, 400]]) {
      expect(classifyApiAnswer(429, { busy: true }, expected, 21)).toEqual({
        status: 'refused',
        answer: "429 this caller's limit was reached",
        note: null,
        ms: 21,
        target: 'site',
      });
    }
  });

  it('a 2xx answer means the request went through', () => {
    expect(classifyApiAnswer(200, { decision: {} }, [402], 5)).toMatchObject({ status: 'not-refused', answer: '200' });
  });

  it('any other status is not the answer the attack is about, so it did not run', () => {
    expect(classifyApiAnswer(500, { error: 'internal error' }, [402], 5).status).toBe('could-not-run');
    expect(classifyApiAnswer(404, {}, [402], 5).status).toBe('could-not-run');
  });

  it('reads the error text, a true key, or a plain status word', () => {
    expect(answerText(429, { busy: true })).toBe('busy');
    expect(answerText(402, {})).toBe('Payment required');
    expect(answerText(400, null)).toBe('Bad request');
    expect(answerText(418, [])).toBe('No text in the answer');
  });

  it('a request that throws could not run', async () => {
    const lost = await runApiAttack(apiAttacks(facts).unpaid, (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    expect(lost).toMatchObject({ status: 'could-not-run', target: 'site' });
  });

  it('a body that is not JSON is still filed by its status', async () => {
    const seen: { url: unknown; init: RequestInit | undefined }[] = [];
    const reply = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response('Payment Required', { status: 402 });
    }) as typeof fetch;
    const result = await runApiAttack(apiAttacks(facts).unpaid, reply);
    expect(result).toMatchObject({ status: 'refused', answer: '402 Payment required' });
    expect(seen[0]?.init).toMatchObject({ method: 'POST', cache: 'no-store' });
  });
});

describe('the bodies the API rows send', () => {
  const attacks = apiAttacks(facts);

  it('row 6 sends the wrong-checksum spelling to the free check', () => {
    expect(attacks.mistyped.path).toBe('/api/check');
    expect(JSON.parse(attacks.mistyped.body)).toEqual({ wallet: mistypedAddress(facts.paidAccount) });
    expect(attacks.mistyped.refusedStatuses).toEqual([400]);
  });

  it('rows 7 and 8 post a valid body to the paid route, the second with a forged header', () => {
    expect(attacks.unpaid.path).toBe('/api/x402/screen');
    expect(attacks.unpaid.headers).not.toHaveProperty('PAYMENT-SIGNATURE');
    expect(attacks.forged.headers['PAYMENT-SIGNATURE']).toBe('not-a-payment');
    expect(attacks.forged.refusedStatuses).toEqual([402, 400]);
    expect(JSON.parse(attacks.unpaid.body)).toEqual({ wallet: facts.paidAccount });
  });

  it('row 9 sends a wallet string of 2,000 characters, over the 1 KB limit', () => {
    const wallet = (JSON.parse(attacks.oversized.body) as { wallet: string }).wallet;
    expect(wallet).toHaveLength(2000);
    expect(wallet.startsWith(facts.paidAccount)).toBe(true);
    expect(new TextEncoder().encode(attacks.oversized.body).length).toBeGreaterThan(1024);
    expect(attacks.oversized.refusedStatuses).toEqual([413, 400]);
  });
});

describe('the markup row', () => {
  it('is refused when the flag is untouched and the paragraph has no child elements', () => {
    expect(judgeRenderedReason({ childElementCount: 0 }, undefined, 4)).toEqual({ status: 'refused', answer: 'Rendered as text, 0 elements', note: null, ms: 4, target: 'site' });
  });

  it('is not refused when an element was made or the flag was set', () => {
    expect(judgeRenderedReason({ childElementCount: 2 }, undefined, 4)).toMatchObject({ status: 'not-refused', answer: '2 elements' });
    expect(judgeRenderedReason({ childElementCount: 0 }, true, 4).status).toBe('not-refused');
  });

  it('could not run with no paragraph, and the text carries the markup the row names', () => {
    expect(judgeRenderedReason(null, undefined, 0).status).toBe('could-not-run');
    expect(MARKUP_REASON).toBe('<img src=x onerror="window.__thuliBroken=true"> <a href="https://example.invalid">claim</a>');
  });
});

describe('shortHash', () => {
  it('shortens the root to its first 10 and last 6 characters', () => {
    expect(shortHash(record.root)).toBe(`${record.root.slice(0, 10)}…${record.root.slice(-6)}`);
  });
});
