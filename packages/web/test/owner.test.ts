// Covers the pure parts of the owner's setup page: the form checks and their exact words, the arguments for the three
// wallet calls, the reason text for every way a call can fail, the kept record and its check, which row the page opens at,
// and the money text rules against the core package. It does not draw anything and does not call a chain or a wallet; the
// browser script runs the whole page against a fork of Base Sepolia.
import fs from 'node:fs';
import path from 'node:path';
import {
  concat,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  HttpRequestError,
  InsufficientFundsError,
  UserRejectedRequestError,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA, THULI_AGENT } from '../lib/contracts';
import {
  approveRequest,
  checkTerms,
  clearResume,
  coverageLine,
  createVaultRequest,
  DEFAULT_CAP,
  DEFAULT_DELAY,
  DEFAULT_DEPOSIT,
  defaultEndDate,
  DELAY_CHOICES,
  describeDelay,
  depositRequest,
  endOfDay,
  formatAmount,
  holdsOf,
  isNotAVault,
  loadResume,
  NOT_ON_NETWORK_MILLISECONDS,
  packResume,
  readAmount,
  readCreation,
  readResume,
  reasonFor,
  REASONS,
  resumeKey,
  saveResume,
  settle,
  stageFor,
  termsFromChain,
  termsFromRecord,
  termsSummary,
  USDC_BASE_SEPOLIA,
  vaultMatches,
  WAIT_LIMIT_KEY,
  waitLimit,
  watchCreation,
  type ResumeRecord,
  type Terms,
  type VaultState,
} from '../lib/owner';
import { FACTORY_ABI, FACTORY_SIGNATURES, TOKEN_ABI, TOKEN_SIGNATURES, VAULT_WRITE_ABI, VAULT_WRITE_SIGNATURES } from '../lib/vaultAbi';

// The core package is loaded by a computed path so the site's own type check does not follow into its sources.
const loadPackage = (name: string): Promise<any> => import(/* @vite-ignore */ name);
const { parseUsdc, formatUsdc } = await loadPackage('@thuli/core');

const deployments = path.join(import.meta.dirname, '..', '..', 'contracts', 'deployments');
const proof = JSON.parse(fs.readFileSync(path.join(deployments, 'base-sepolia-proof.json'), 'utf8')) as { token: string; agent: string; factory: string };

const WALLET = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const VAULT = '0xAdb8aD5A8BC359fF17D81DBe41833bB6b26B2034';
const HASH = '0xda041583c1c4170d470e537c7d36f41fc1912b398758a3612d492960e45bd13c';
const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
const NOW = NOW_MS / 1000;
const DAY = 86_400;

describe('constants against the deployment records', () => {
  it('THULI_AGENT is the agent the proof record names', () => {
    expect(THULI_AGENT.toLowerCase()).toBe(proof.agent.toLowerCase());
  });

  it('the reward token is the USDC the proof record names', () => {
    expect(USDC_BASE_SEPOLIA.toLowerCase()).toBe(proof.token.toLowerCase());
  });

  it('the factory is the one the proof record names, on Base Sepolia', () => {
    expect(BASE_SEPOLIA.factory.toLowerCase()).toBe(proof.factory.toLowerCase());
    expect(BASE_SEPOLIA.chainId).toBe(84532);
  });
});

describe('the new ABI entries against the generated ABI', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'worker', 'src', 'vault', 'abi.ts'), 'utf8');
  type Item = { type: string; name?: string; inputs?: { type: string; indexed?: boolean }[]; outputs?: { type: string }[]; stateMutability?: string };
  const section = (name: string): Item[] => {
    const start = source.indexOf('[', source.indexOf(`export const ${name}`));
    const end = source.indexOf('] as const', start);
    return JSON.parse(source.slice(start, end + 1)) as Item[];
  };
  const generated = [...section('VAULT_ABI'), ...section('FACTORY_ABI')];
  const types = (list: string | undefined) => (list ?? '').split(',').map((entry) => entry.trim().split(/\s+/)[0] as string).filter((entry) => entry !== '');

  for (const signature of [...FACTORY_SIGNATURES, ...VAULT_WRITE_SIGNATURES]) {
    it(`${signature} appears there with the same parameter types`, () => {
      const parts = /^(function|error|event) (\w+)\((.*?)\)(?: returns \((.*)\))?$/.exec(signature);
      expect(parts).not.toBeNull();
      const [, kind, name, params, returns] = parts as RegExpExecArray;
      const item = generated.find((entry) => entry.type === kind && entry.name === name);
      expect(item, `${name} is missing from the worker ABI`).toBeDefined();
      expect((item?.inputs ?? []).map((input) => input.type)).toEqual(types(params));
      if (kind === 'event') {
        const indexed = (params ?? '').split(',').map((entry) => /\bindexed\b/.test(entry));
        expect((item?.inputs ?? []).map((input) => input.indexed === true)).toEqual(indexed);
      }
      if (kind === 'function') expect((item?.outputs ?? []).map((output) => output.type)).toEqual(types(returns));
    });
  }

  it('the token entries are the ones viem keeps for ERC-20', () => {
    for (const name of ['balanceOf', 'allowance', 'approve'] as const) {
      const mine = TOKEN_ABI.find((entry) => entry.type === 'function' && entry.name === name);
      const theirs = erc20Abi.find((entry) => entry.type === 'function' && entry.name === name) as { inputs: { type: string }[]; outputs: { type: string }[] } | undefined;
      expect(mine?.type === 'function' && mine.inputs.map((input) => input.type)).toEqual(theirs?.inputs.map((input) => input.type));
      expect(mine?.type === 'function' && mine.outputs.map((output) => output.type)).toEqual(theirs?.outputs.map((output) => output.type));
    }
    expect(TOKEN_ABI).toHaveLength(TOKEN_SIGNATURES.length);
  });

  it('the ABIs parse to one item per signature', () => {
    expect(FACTORY_ABI).toHaveLength(FACTORY_SIGNATURES.length);
    expect(VAULT_WRITE_ABI).toHaveLength(VAULT_WRITE_SIGNATURES.length);
  });

  it('createVault and deposit encode to the same bytes as the generated ABI', () => {
    const terms: Terms = { cap: 1_000_000n, deposit: 20_000_000n, endTime: 1_800_000_000, rootDelay: 3600 };
    const request = createVaultRequest(WALLET, terms);
    const encode = (abi: unknown, functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi, functionName, args } as never);
    expect(encode(request.abi, 'createVault', request.args)).toBe(encode(section('FACTORY_ABI'), 'createVault', request.args));
    const deposit = depositRequest(VAULT, 20_000_000n);
    expect(encode(deposit.abi, 'deposit', deposit.args)).toBe(encode(section('VAULT_ABI'), 'deposit', [20_000_000n]));
    const approve = approveRequest(VAULT, 20_000_000n);
    expect(encode(approve.abi, 'approve', approve.args)).toBe(encode(erc20Abi, 'approve', [VAULT, 20_000_000n]));
  });
});

describe('money text against the core package', () => {
  const valid = ['0', '1', '20', '0.000001', '1.5', '2.50', '999999999999999999999999999999', '999999999999999999999999999999.999999', '0.1'];
  const refused = ['', '01', '.5', '5.', '1e3', '-1', '+1', '1,5', '1 0', 'abc', '0x10', '٣', '1000000000000000000000000000000', '1.1234567', '1..2'];

  for (const text of valid) {
    it(`reads ${text} to the same units the core package does`, () => {
      expect(readAmount(text)).toEqual({ kind: 'ok', units: parseUsdc(text) });
      expect(formatAmount(parseUsdc(text))).toBe(formatUsdc(parseUsdc(text)));
    });
  }

  for (const text of refused) {
    it(`refuses ${JSON.stringify(text)} where the core package refuses it`, () => {
      expect(() => parseUsdc(text)).toThrow();
      expect(readAmount(text).kind).not.toBe('ok');
    });
  }

  it('tells too many decimals apart from any other bad text', () => {
    expect(readAmount('1.1234567')).toEqual({ kind: 'decimals' });
    expect(readAmount('0.0000001')).toEqual({ kind: 'decimals' });
    expect(readAmount('12.1234567891')).toEqual({ kind: 'decimals' });
    expect(readAmount('abc')).toEqual({ kind: 'bad' });
    expect(readAmount('')).toEqual({ kind: 'bad' });
    expect(readAmount('1.')).toEqual({ kind: 'bad' });
  });

  it('trims the spaces a pasted amount comes with, and nothing else', () => {
    expect(readAmount('  5 ')).toEqual({ kind: 'ok', units: 5_000_000n });
    expect(readAmount('5 5').kind).toBe('bad');
  });

  it('writes base units back to the text the core package writes', () => {
    for (const units of [0n, 1n, 999_999n, 1_000_000n, 1_500_000n, 20_000_000n, 123_456_789_012n]) expect(formatAmount(units)).toBe(formatUsdc(units));
  });
});

describe('the end date', () => {
  it('defaults to 30 days from the UTC day of now', () => {
    expect(defaultEndDate(NOW_MS)).toBe('2026-12-11');
    expect(defaultEndDate(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2027-01-30');
  });

  it('ends at 23:59:59 UTC of the chosen day, in whole seconds', () => {
    expect(endOfDay('2026-12-11')).toBe(Date.UTC(2026, 11, 11, 23, 59, 59) / 1000);
    expect(Number.isInteger(endOfDay('2026-12-11'))).toBe(true);
  });

  it('gives nothing for text that is not a real day', () => {
    for (const text of ['', '2026-02-30', '2026-13-01', '26-12-11', '2026-1-1', 'tomorrow', '0050-01-01', '2026-12-11T00:00']) expect(endOfDay(text)).toBeNull();
  });
});

describe('the checks on the terms', () => {
  const form = { cap: DEFAULT_CAP, deposit: DEFAULT_DEPOSIT, endDate: '2026-12-11', delay: DEFAULT_DELAY };

  it('start at 1 USDC cap, 20 USDC deposit, a 1 hour wait and a date 30 days away, and pass', () => {
    expect([DEFAULT_CAP, DEFAULT_DEPOSIT, DEFAULT_DELAY]).toEqual(['1', '20', 3600]);
    const result = checkTerms(form, null, NOW);
    expect(result.errors).toEqual({});
    expect(result.terms).toEqual({ cap: 1_000_000n, deposit: 20_000_000n, endTime: Date.UTC(2026, 11, 11, 23, 59, 59) / 1000, rootDelay: 3600 });
  });

  it('offers the four waiting times, in order, with the words the page shows', () => {
    expect(DELAY_CHOICES).toEqual([
      { label: '1 hour', seconds: 3600 },
      { label: '6 hours', seconds: 21_600 },
      { label: '24 hours', seconds: 86_400 },
      { label: '3 days', seconds: 259_200 },
    ]);
  });

  it('asks for an amount above zero when the cap or the deposit is empty, zero or not a number', () => {
    for (const text of ['', '0', '0.000000', 'abc', '1e3']) {
      expect(checkTerms({ ...form, cap: text }, null, NOW).errors.cap).toBe('Enter an amount above zero.');
      expect(checkTerms({ ...form, deposit: text }, null, NOW).errors.deposit).toBe('Enter an amount above zero.');
    }
  });

  it('asks for at most 6 decimal places', () => {
    expect(checkTerms({ ...form, cap: '1.0000001' }, null, NOW).errors.cap).toBe('Use at most 6 decimal places.');
    expect(checkTerms({ ...form, deposit: '20.1234567' }, null, NOW).errors.deposit).toBe('Use at most 6 decimal places.');
  });

  it('wants the deposit to cover at least one wallet', () => {
    expect(checkTerms({ ...form, cap: '5', deposit: '4.999999' }, null, NOW).errors.deposit).toBe('The deposit must cover at least one wallet.');
    expect(checkTerms({ ...form, cap: '5', deposit: '5' }, null, NOW).errors).toEqual({});
  });

  it('says what the wallet holds when the deposit is more, and only once the balance has been read', () => {
    expect(checkTerms(form, 5_000_000n, NOW).errors.deposit).toBe('This wallet holds only 5 USDC.');
    expect(checkTerms(form, 1_500_000n, NOW).errors.deposit).toBe('This wallet holds only 1.5 USDC.');
    expect(checkTerms(form, 20_000_000n, NOW).errors).toEqual({});
    expect(checkTerms(form, null, NOW).errors).toEqual({});
  });

  it('checks the cap before it compares the deposit with it', () => {
    expect(checkTerms({ ...form, cap: 'abc' }, null, NOW).errors).toEqual({ cap: 'Enter an amount above zero.' });
  });

  it('wants the end at least a day away, counted to 23:59:59 UTC of the chosen day', () => {
    const tooSoon = 'The end must be at least a day away.';
    expect(checkTerms({ ...form, endDate: '2026-11-11' }, null, NOW).errors.end).toBe(tooSoon);
    expect(checkTerms({ ...form, endDate: '2026-11-10' }, null, NOW).errors.end).toBe(tooSoon);
    expect(checkTerms({ ...form, endDate: '' }, null, NOW).errors.end).toBe(tooSoon);
    expect(checkTerms({ ...form, endDate: '2026-11-12' }, null, NOW).errors).toEqual({});
    // The end is 23:59:59 on the 12th: exactly a day from 23:59:59 on the 11th, one second short from midnight on the 12th.
    expect(checkTerms({ ...form, endDate: '2026-11-12' }, null, Date.UTC(2026, 10, 11, 23, 59, 59) / 1000).errors).toEqual({});
    expect(checkTerms({ ...form, endDate: '2026-11-12' }, null, Date.UTC(2026, 10, 12, 0, 0, 0) / 1000).errors.end).toBe(tooSoon);
  });

  it('wants the end at most 365 days away', () => {
    const tooFar = 'The end can be at most 365 days away.';
    expect(checkTerms({ ...form, endDate: '2027-11-10' }, null, NOW).errors).toEqual({});
    expect(checkTerms({ ...form, endDate: '2027-11-11' }, null, NOW).errors.end).toBe(tooFar);
    expect(checkTerms({ ...form, endDate: '2030-01-01' }, null, NOW).errors.end).toBe(tooFar);
    expect(checkTerms({ ...form, endDate: '123456-01-01' }, null, NOW).errors.end).toBe(tooFar);
  });

  it('gives no terms while any field has an error, and every field its own error', () => {
    const result = checkTerms({ cap: '', deposit: '0', endDate: '', delay: 3600 }, null, NOW);
    expect(result.terms).toBeNull();
    expect(Object.keys(result.errors).sort()).toEqual(['cap', 'deposit', 'end']);
  });

  it('refuses a waiting time that is not one of the four', () => {
    expect(checkTerms({ ...form, delay: 7200 }, null, NOW).terms).toBeNull();
  });

  it('counts the wallets a deposit covers at the cap, rounded down', () => {
    expect(coverageLine(1_000_000n, 20_000_000n)).toBe('Covers 20 wallets at the cap.');
    expect(coverageLine(3_000_000n, 10_000_000n)).toBe('Covers 3 wallets at the cap.');
    expect(coverageLine(1_000_000n, 1_999_999n)).toBe('Covers 1 wallet at the cap.');
  });
});

describe('the three wallet calls', () => {
  const terms: Terms = { cap: 1_000_000n, deposit: 20_000_000n, endTime: 1_800_000_000, rootDelay: 3600 };

  it('createVault goes to the factory with the token, the owner, the agent, the cap, the end and the wait, in that order', () => {
    const request = createVaultRequest(WALLET, terms);
    expect(request.address).toBe(BASE_SEPOLIA.factory);
    expect(request.functionName).toBe('createVault');
    expect(request.args).toEqual([USDC_BASE_SEPOLIA, WALLET, THULI_AGENT, 1_000_000n, 1_800_000_000n, 3600]);
    expect(typeof request.args[4]).toBe('bigint');
    expect(typeof request.args[5]).toBe('number');
  });

  it('the owner is the connected wallet and never Thuli', () => {
    expect(createVaultRequest(WALLET, terms).args[1]).toBe(WALLET);
    expect(createVaultRequest(WALLET, terms).args[2]).toBe(THULI_AGENT);
  });

  it('approve goes to the token, for the vault, for exactly the deposit', () => {
    const request = approveRequest(VAULT, terms.deposit);
    expect(request.address).toBe(USDC_BASE_SEPOLIA);
    expect(request.functionName).toBe('approve');
    expect(request.args).toEqual([VAULT, 20_000_000n]);
  });

  it('deposit goes to the vault with the amount', () => {
    const request = depositRequest(VAULT, terms.deposit);
    expect(request.address).toBe(VAULT);
    expect(request.functionName).toBe('deposit');
    expect(request.args).toEqual([20_000_000n]);
  });
});

describe('the reasons', () => {
  const asRevert = (errorName: string, args: unknown[] = [], step: 'createVault' | 'deposit' | 'approve' = 'createVault') => {
    const abi = errorName === 'SafeERC20FailedOperation' ? VAULT_WRITE_ABI : FACTORY_ABI;
    const data = encodeErrorResult({ abi, errorName, args } as never);
    const reverted = new ContractFunctionRevertedError({ abi, data, functionName: step });
    return new ContractFunctionExecutionError(reverted, { abi, functionName: step, args: [], sender: WALLET as `0x${string}` });
  };
  const asString = (message: string, step: 'createVault' | 'deposit' | 'approve') => {
    const data = concat(['0x08c379a0', encodeAbiParameters([{ type: 'string' }], [message])]);
    const reverted = new ContractFunctionRevertedError({ abi: FACTORY_ABI, data, functionName: step });
    return new ContractFunctionExecutionError(reverted, { abi: FACTORY_ABI, functionName: step, args: [], sender: WALLET as `0x${string}` });
  };

  it('has every sentence the page may show, word for word', () => {
    expect(REASONS).toEqual({
      declined: 'You declined in your wallet. Nothing was sent.',
      noGas: 'This wallet has no Base Sepolia ETH to pay gas.',
      zeroCap: 'The cap must be above zero.',
      delayRange: 'The waiting time must be between 1 hour and 30 days.',
      endTooSoon: 'The end is too close: a list could not pay before it.',
      endTooFar: 'The end can be at most 365 days away.',
      token: "The token refused the transfer. Check the wallet's USDC balance.",
      network: 'The network refused this transaction. Nothing moved.',
      notOnNetwork: 'This transaction is not on the network. Nothing moved.',
      other: 'This could not be sent. Nothing moved.',
    });
  });

  it('knows a wallet that was declined, wherever the refusal sits in the error', () => {
    expect(reasonFor(new UserRejectedRequestError(new Error('User rejected the request.')), 'create')).toBe(REASONS.declined);
    const wrapped = new ContractFunctionExecutionError(new UserRejectedRequestError(new Error('no')), { abi: FACTORY_ABI, functionName: 'createVault', args: [] });
    expect(reasonFor(wrapped, 'create')).toBe(REASONS.declined);
    expect(reasonFor(Object.assign(new Error('User denied transaction signature.'), { code: 4001 }), 'deposit')).toBe(REASONS.declined);
  });

  it('knows a wallet with no ETH', () => {
    expect(reasonFor(new InsufficientFundsError(), 'create')).toBe(REASONS.noGas);
    expect(reasonFor(Object.assign(new Error('Insufficient funds for gas * price + value'), { code: -32003 }), 'approve')).toBe(REASONS.noGas);
  });

  it('knows each of the four refusals the vault gives while it is made', () => {
    expect(reasonFor(asRevert('ZeroCap'), 'create')).toBe(REASONS.zeroCap);
    expect(reasonFor(asRevert('RootDelayOutOfRange', [60]), 'create')).toBe(REASONS.delayRange);
    expect(reasonFor(asRevert('EndTimeTooSoon', [1_800_000_000n, 1_800_005_000n]), 'create')).toBe(REASONS.endTooSoon);
    expect(reasonFor(asRevert('EndTimeOutOfRange', [1_900_000_000n]), 'create')).toBe(REASONS.endTooFar);
  });

  it('calls a token that refused the transfer or the allowance a token refusal', () => {
    expect(reasonFor(asRevert('SafeERC20FailedOperation', [USDC_BASE_SEPOLIA], 'deposit'), 'deposit')).toBe(REASONS.token);
    expect(reasonFor(asString('ERC20: transfer amount exceeds balance', 'deposit'), 'deposit')).toBe(REASONS.token);
    expect(reasonFor(asString('ERC20: transfer amount exceeds allowance', 'deposit'), 'deposit')).toBe(REASONS.token);
    expect(reasonFor(asString('ERC20: approve to the zero address', 'approve'), 'approve')).toBe(REASONS.token);
  });

  it('does not call a plain text refusal in createVault a token refusal', () => {
    expect(reasonFor(asString('something odd', 'createVault'), 'create')).toBe(REASONS.other);
  });

  it('falls back to the plain sentence for anything else, and never shows the raw error', () => {
    const unknown = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: FACTORY_ABI, data: '0xdeadbeef', functionName: 'createVault' }), { abi: FACTORY_ABI, functionName: 'createVault', args: [] });
    for (const error of [new Error('boom at /secret/path.ts:12'), unknown, 'a string', null, undefined, { weird: true }, 42]) {
      expect(reasonFor(error, 'create')).toBe(REASONS.other);
    }
    expect(reasonFor(new Error('boom at /secret/path.ts:12'), 'deposit')).not.toContain('boom');
  });

  it('only ever gives one of the ten sentences, whatever error comes in', () => {
    const sentences = new Set<string>(Object.values(REASONS));
    const errors = [new Error('x'), asRevert('ZeroCap'), asString('Bad stuff at C:\secret', 'deposit'), new InsufficientFundsError(), { message: 'raw' }, 'text', 7, null];
    for (const error of errors) for (const step of ['create', 'approve', 'deposit'] as const) expect(sentences.has(reasonFor(error, step))).toBe(true);
  });

  it('is never fooled by an error that points at itself', () => {
    const loop: { cause?: unknown; name: string } = { name: 'Loop' };
    loop.cause = loop;
    expect(reasonFor(loop, 'create')).toBe(REASONS.other);
  });
});

describe('the record kept in the browser', () => {
  const record = { vault: VAULT, txHash: HASH, cap: '1000000', deposit: '20000000', endTime: 1_800_000_000, rootDelay: 3600 };

  it('is kept under the wallet and the chain, spelled in lower case', () => {
    expect(resumeKey(WALLET, 84532)).toBe(`thuli.owner.v1.${WALLET.toLowerCase()}.84532`);
    expect(resumeKey(WALLET, 8453)).not.toBe(resumeKey(WALLET, 84532));
    expect(resumeKey(WALLET.toLowerCase(), 84532)).toBe(resumeKey(WALLET, 84532));
  });

  it('reads back what was packed', () => {
    expect(readResume(packResume(record))).toEqual(record);
  });

  it('reads nothing from nothing, text that is not JSON, or JSON of the wrong shape', () => {
    for (const raw of [null, '', 'not json', '[]', 'null', '{}', '42', JSON.stringify({ ...record, vault: '0x12' }), JSON.stringify({ ...record, txHash: 'hash' }), JSON.stringify({ ...record, cap: '0' }), JSON.stringify({ ...record, cap: '1.5' }), JSON.stringify({ ...record, deposit: 20 }), JSON.stringify({ ...record, endTime: -1 }), JSON.stringify({ ...record, endTime: 1.5 }), JSON.stringify({ ...record, rootDelay: 'x' }), JSON.stringify({ ...record, rootDelay: 0 })]) {
      expect(readResume(raw)).toBeNull();
    }
  });

  const memory = () => {
    const map = new Map<string, string>();
    return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
  };

  it('is found again for the wallet that saved it and for no other wallet, nor on another chain', () => {
    const storage = memory();
    saveResume(storage, WALLET, 84532, record);
    expect(loadResume(storage, WALLET, 84532)).toEqual(record);
    expect(loadResume(storage, WALLET.toLowerCase(), 84532)).toEqual(record);
    expect(loadResume(storage, VAULT, 84532)).toBeNull();
    expect(loadResume(storage, WALLET, 8453)).toBeNull();
  });

  it('is gone after it is cleared, and a damaged value under the right key is no record', () => {
    const storage = memory();
    saveResume(storage, WALLET, 84532, record);
    clearResume(storage, WALLET, 84532);
    expect(loadResume(storage, WALLET, 84532)).toBeNull();
    storage.setItem(resumeKey(WALLET, 84532), '{"vault":"0x12"}');
    expect(loadResume(storage, WALLET, 84532)).toBeNull();
    expect(storage.map.has(resumeKey(WALLET, 84532))).toBe(false);
  });

  it('does not fail where the browser refuses storage', () => {
    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveResume(refusing, WALLET, 84532, record)).not.toThrow();
    expect(() => clearResume(refusing, WALLET, 84532)).not.toThrow();
    expect(loadResume(refusing, WALLET, 84532)).toBeNull();
    expect(loadResume(null, WALLET, 84532)).toBeNull();
    expect(() => saveResume(null, WALLET, 84532, record)).not.toThrow();
  });

  it('keeps only the six fields it knows', () => {
    const read = readResume(JSON.stringify({ ...record, version: 1, extra: 'x' }));
    expect(read).toEqual(record);
    expect(Object.keys(read ?? {}).sort()).toEqual(['cap', 'deposit', 'endTime', 'rootDelay', 'txHash', 'vault']);
  });
});

describe('what the chain says about the vault', () => {
  const state: VaultState = {
    token: USDC_BASE_SEPOLIA,
    owner: WALLET,
    agent: THULI_AGENT,
    perWalletCap: 1_000_000n,
    endTime: 1_800_000_000n,
    rootDelay: 3600,
    deposited: 0n,
    totalPaid: 0n,
  };
  const record = { vault: VAULT, txHash: HASH, cap: '9', deposit: '20000000', endTime: 5, rootDelay: 60 };

  it("is the connected wallet's vault only when the owner, the token and the agent are the ones this page makes", () => {
    expect(vaultMatches(state, WALLET)).toBe(true);
    expect(vaultMatches(state, WALLET.toLowerCase())).toBe(true);
    expect(vaultMatches({ ...state, owner: VAULT }, WALLET)).toBe(false);
    expect(vaultMatches({ ...state, token: VAULT }, WALLET)).toBe(false);
    expect(vaultMatches({ ...state, agent: VAULT }, WALLET)).toBe(false);
  });

  it('shows the cap, the end and the wait from the chain and only the planned deposit from the record', () => {
    expect(termsFromChain(state, record)).toEqual({ cap: 1_000_000n, deposit: 20_000_000n, endTime: 1_800_000_000, rootDelay: 3600 });
  });

  it('holds what was deposited less what was paid', () => {
    expect(holdsOf({ ...state, deposited: 20_000_000n, totalPaid: 0n })).toBe(20_000_000n);
    expect(holdsOf({ ...state, deposited: 20_000_000n, totalPaid: 3_000_000n })).toBe(17_000_000n);
  });

  it('tells an address that is no vault from a read that never got there', () => {
    const wrap = (cause: Error) => new ContractFunctionExecutionError(cause as never, { abi: FACTORY_ABI, functionName: 'state', args: [] });
    expect(isNotAVault(wrap(new ContractFunctionZeroDataError({ functionName: 'state' })))).toBe(true);
    expect(isNotAVault(wrap(new ContractFunctionRevertedError({ abi: FACTORY_ABI, data: '0xdeadbeef', functionName: 'state' })))).toBe(true);
    expect(isNotAVault(wrap(new HttpRequestError({ url: 'https://sepolia.base.org' })))).toBe(false);
    expect(isNotAVault(new Error('offline'))).toBe(false);
    expect(isNotAVault(null)).toBe(false);
  });

  it('opens at the deposit row when the allowance covers it, at the allow row when it does not, and shows the funded card when the vault has it', () => {
    expect(stageFor({ deposited: 0n, planned: 20_000_000n, allowance: null })).toBe('reading');
    expect(stageFor({ deposited: 0n, planned: 20_000_000n, allowance: 0n })).toBe('allow');
    expect(stageFor({ deposited: 0n, planned: 20_000_000n, allowance: 19_999_999n })).toBe('allow');
    expect(stageFor({ deposited: 0n, planned: 20_000_000n, allowance: 20_000_000n })).toBe('deposit');
    expect(stageFor({ deposited: 0n, planned: 20_000_000n, allowance: 50_000_000n })).toBe('deposit');
    expect(stageFor({ deposited: 20_000_000n, planned: 20_000_000n, allowance: 0n })).toBe('funded');
    expect(stageFor({ deposited: 20_000_000n, planned: 20_000_000n, allowance: null })).toBe('funded');
    expect(stageFor({ deposited: 25_000_000n, planned: 20_000_000n, allowance: 0n })).toBe('funded');
  });
});

describe('the words under a row and the links', () => {
  it('summarises the terms in one line', () => {
    expect(termsSummary({ cap: 1_000_000n, deposit: 20_000_000n, endTime: Date.UTC(2026, 11, 11, 23, 59, 59) / 1000, rootDelay: 3600 })).toBe(
      'Cap 1 USDC, deposit 20 USDC, ends 11 Dec 2026, 23:59 UTC, waits 1 hour.',
    );
  });

  it('names a waiting time by the choice it came from, or by hours and days when the chain gave another', () => {
    expect(describeDelay(3600)).toBe('1 hour');
    expect(describeDelay(21_600)).toBe('6 hours');
    expect(describeDelay(86_400)).toBe('24 hours');
    expect(describeDelay(259_200)).toBe('3 days');
    expect(describeDelay(7200)).toBe('2 hours');
    expect(describeDelay(172_800)).toBe('2 days');
    expect(describeDelay(90)).toBe('90 seconds');
  });
});

describe('waiting for the chain to show a change', () => {
  const noWait = async () => {};

  it('returns at once when the first read is enough', async () => {
    let reads = 0;
    const result = await settle(async () => ++reads, (value) => value >= 1, { tries: 5, wait: noWait });
    expect(result).toEqual({ ok: true, value: 1 });
    expect(reads).toBe(1);
  });

  it('reads again until the answer is enough', async () => {
    let reads = 0;
    const result = await settle(async () => ++reads, (value) => value >= 3, { tries: 5, wait: noWait });
    expect(result).toEqual({ ok: true, value: 3 });
  });

  it('keeps going past a read that fails, and gives up after the tries it was given', async () => {
    let reads = 0;
    const flaky = await settle(
      async () => {
        reads += 1;
        if (reads < 3) throw new Error('down');
        return reads;
      },
      (value) => value >= 3,
      { tries: 5, wait: noWait },
    );
    expect(flaky).toEqual({ ok: true, value: 3 });
    let calls = 0;
    const never = await settle(async () => ++calls, () => false, { tries: 4, wait: noWait });
    expect(never).toEqual({ ok: false, value: 4 });
    expect(calls).toBe(4);
    const dead = await settle(async () => Promise.reject(new Error('down')), () => true, { tries: 2, wait: noWait });
    expect(dead).toEqual({ ok: false, value: null });
  });
});

describe('a creation that was sent and not yet seen', () => {
  const sent: ResumeRecord = { vault: null, txHash: HASH, cap: '1000000', deposit: '20000000', endTime: 1_800_000_000, rootDelay: 3600 };
  const made: ResumeRecord = { ...sent, vault: VAULT };

  it('is kept with its hash and the accepted terms, and no vault', () => {
    expect(readResume(packResume(sent))).toEqual(sent);
    expect(readResume(packResume(made))).toEqual(made);
    expect(termsFromRecord(sent)).toEqual({ cap: 1_000_000n, deposit: 20_000_000n, endTime: 1_800_000_000, rootDelay: 3600 });
  });

  it('is refused when it has neither a vault nor a hash, or when what it has is not a vault or a hash', () => {
    expect(readResume(JSON.stringify({ ...sent, txHash: null }))).toBeNull();
    expect(readResume(JSON.stringify({ cap: sent.cap, deposit: sent.deposit, endTime: sent.endTime, rootDelay: sent.rootDelay }))).toBeNull();
    expect(readResume(JSON.stringify({ ...sent, vault: null, txHash: 'not a hash' }))).toBeNull();
    expect(readResume(JSON.stringify({ ...sent, vault: '0x12' }))).toBeNull();
    expect(readResume(JSON.stringify({ ...sent, vault: 42 }))).toBeNull();
  });

  it('is found again under the wallet, and a damaged one is removed', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
    saveResume(storage, WALLET, 84532, sent);
    expect(loadResume(storage, WALLET, 84532)).toEqual(sent);
    map.set(resumeKey(WALLET, 84532), JSON.stringify({ ...sent, vault: null, txHash: null }));
    expect(loadResume(storage, WALLET, 84532)).toBeNull();
    expect(map.has(resumeKey(WALLET, 84532))).toBe(false);
  });
});

describe('reading a creation receipt', () => {
  const log = (owner: string, address: string = BASE_SEPOLIA.factory) => ({
    address,
    topics: encodeEventTopics({ abi: FACTORY_ABI, eventName: 'VaultCreated', args: { vault: VAULT, owner, agent: THULI_AGENT } as never }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint32' }], [USDC_BASE_SEPOLIA, 1_000_000n, 1_800_000_000n, 3600]),
  });

  it('finds the vault and the terms in the factory log when the transaction succeeded', () => {
    const read = readCreation({ status: 'success', logs: [log(WALLET)] }, WALLET.toLowerCase());
    expect(read).toEqual({ kind: 'created', vault: VAULT, cap: 1_000_000n, endTime: 1_800_000_000n, rootDelay: 3600 });
  });

  it('is reverted when the transaction was mined and failed, whatever logs it has', () => {
    expect(readCreation({ status: 'reverted', logs: [] }, WALLET)).toEqual({ kind: 'reverted' });
    expect(readCreation({ status: 'reverted', logs: [log(WALLET)] }, WALLET)).toEqual({ kind: 'reverted' });
  });

  it('finds no vault in a log from another contract, for another owner, or in no logs', () => {
    expect(readCreation({ status: 'success', logs: [log(WALLET, VAULT)] }, WALLET)).toEqual({ kind: 'no-event' });
    expect(readCreation({ status: 'success', logs: [log(VAULT)] }, WALLET)).toEqual({ kind: 'no-event' });
    expect(readCreation({ status: 'success', logs: [] }, WALLET)).toEqual({ kind: 'no-event' });
  });
});

describe('waiting for a sent creation to show up', () => {
  const LIMIT = NOT_ON_NETWORK_MILLISECONDS;
  const clock = () => {
    const state = { time: 0, waits: 0 };
    return {
      state,
      now: () => state.time,
      wait: async (ms: number) => {
        state.time += ms;
        state.waits += 1;
      },
    };
  };

  it('gives the network 120 seconds, and a test can only shorten that', () => {
    expect(LIMIT).toBe(120_000);
    expect(WAIT_LIMIT_KEY).toBe('thuli.owner.waitLimitMs');
    expect(waitLimit(null)).toBe(120_000);
    expect(waitLimit('5000')).toBe(5000);
    for (const raw of ['', 'abc', '0', '-5', 'NaN', 'Infinity', '120001', '9999999']) expect(waitLimit(raw)).toBe(120_000);
    expect(waitLimit('120000')).toBe(120_000);
  });

  it('ends with the receipt when the network shows one', async () => {
    const { now, wait, state } = clock();
    let polls = 0;
    const outcome = await watchCreation(
      HASH,
      { receipt: async () => (++polls >= 3 ? { status: 'success' } : null), known: async () => true },
      { limitMilliseconds: LIMIT, pollMilliseconds: 2000, now, wait },
    );
    expect(outcome).toEqual({ kind: 'mined', receipt: { status: 'success' } });
    expect(state.time).toBe(4000);
  });

  it('hands back a reverted receipt as a receipt, for the page to read', async () => {
    const { now, wait } = clock();
    const outcome = await watchCreation(HASH, { receipt: async () => ({ status: 'reverted' }), known: async () => true }, { limitMilliseconds: LIMIT, pollMilliseconds: 2000, now, wait });
    expect(outcome).toEqual({ kind: 'mined', receipt: { status: 'reverted' } });
  });

  it('ends as not on the network once the network has said it does not know it for the whole limit', async () => {
    const { now, wait, state } = clock();
    const outcome = await watchCreation(HASH, { receipt: async () => null, known: async () => false }, { limitMilliseconds: LIMIT, pollMilliseconds: 2000, now, wait });
    expect(outcome).toEqual({ kind: 'not-on-network' });
    expect(state.time).toBeGreaterThanOrEqual(LIMIT);
    expect(state.time).toBeLessThan(LIMIT + 2000 + 1);
  });

  it('keeps waiting as long as the network knows the transaction, however long it takes', async () => {
    const { now, wait, state } = clock();
    let polls = 0;
    const outcome = await watchCreation(
      HASH,
      { receipt: async () => (++polls > 400 ? { status: 'success' } : null), known: async () => true },
      { limitMilliseconds: LIMIT, pollMilliseconds: 2000, now, wait },
    );
    expect(outcome.kind).toBe('mined');
    expect(state.time).toBeGreaterThan(LIMIT * 5);
  });

  it('starts the count again when the network knows it for a moment, and does not count a read that failed', async () => {
    const { now, wait } = clock();
    let polls = 0;
    const outcome = await watchCreation(
      HASH,
      {
        receipt: async () => null,
        known: async () => {
          polls += 1;
          if (polls === 30) return true;
          if (polls > 30 && polls < 40) throw new Error('offline');
          return false;
        },
      },
      { limitMilliseconds: LIMIT, pollMilliseconds: 2000, now, wait },
    );
    expect(outcome).toEqual({ kind: 'not-on-network' });
    expect(polls).toBeGreaterThan(30 + 9 + 59);
  });

  it('stops quietly when the page asks it to', async () => {
    const { now, wait } = clock();
    let stop = false;
    const outcome = await watchCreation(
      HASH,
      {
        receipt: async () => {
          stop = true;
          return null;
        },
        known: async () => true,
      },
      { limitMilliseconds: LIMIT, pollMilliseconds: 2000, now, wait, stopped: () => stop },
    );
    expect(outcome).toEqual({ kind: 'stopped' });
  });
});
