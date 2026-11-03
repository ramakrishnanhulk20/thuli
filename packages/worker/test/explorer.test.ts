// Not covered here: a live Etherscan or Blockscout reply (every reply is a stub and no request leaves the machine),
// wording those explorers might use for rate limits or unindexed ranges beyond the strings below, network timeouts,
// and how a caller turns these pages into a first funder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerError, explorerSource, type ExplorerSource } from '../src/chain/explorer.ts';

const WALLET = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'ef'.repeat(20)}`;
const FUNDER = `0x${'CD'.repeat(20)}`;
const KEY = 'K3YSECRET9f8e7d6c5b4a3210';
const V2 = 'https://api.etherscan.io/v2/api';
const LEGACY = 'https://eth.blockscout.com/api';
const END = 18_000_000;
const NOTHING = { status: '0', message: 'No transactions found', result: [] };

let cacheDir: string;
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
  throw new Error('unexpected request');
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function answer(...replies: unknown[]): void {
  for (const body of replies) fetchMock.mockResolvedValueOnce(json(body));
}

/** A null key means the source is built with no apiKey at all. */
function source(baseUrl = V2, apiKey: string | null = KEY, perSecond = 1000): ExplorerSource {
  return explorerSource({ baseUrl, apiKey: apiKey ?? undefined, chainId: 1, perSecond, cacheDir });
}

function requested(call: number): URL {
  return new URL(String(fetchMock.mock.calls[call]?.[0]));
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    blockNumber: '100',
    timeStamp: '1700000000',
    hash: `0x${'A1'.repeat(32)}`,
    from: FUNDER,
    to: WALLET,
    value: '1000000000000000000',
    isError: '0',
    ...overrides,
  };
}

const ok = (rows: unknown[]) => ({ status: '1', message: 'OK', result: rows });

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-explorer-'));
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error('unexpected request');
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('explorerSource requests', () => {
  it('sends chainid and the key to a v2 URL, and neither to a legacy URL given no key', async () => {
    answer(NOTHING, NOTHING);
    await source(V2, KEY).oldestTransfers(`0x${'AB'.repeat(20)}`, END, 25);
    expect(Object.fromEntries(requested(0).searchParams)).toEqual({
      module: 'account',
      action: 'txlist',
      address: WALLET,
      startblock: '0',
      endblock: String(END),
      page: '1',
      offset: '25',
      sort: 'asc',
      chainid: '1',
      apikey: KEY,
    });

    await source(LEGACY, null).oldestInternalTransfers(WALLET, END, 25);
    const legacy = requested(1);
    expect(`${legacy.origin}${legacy.pathname}`).toBe(LEGACY);
    expect(legacy.searchParams.get('action')).toBe('txlistinternal');
    expect(legacy.searchParams.has('chainid')).toBe(false);
    expect(legacy.searchParams.has('apikey')).toBe(false);
  });
});

describe('explorerSource replies', () => {
  it('maps external and internal rows oldest first, lowercased, with empty to as null and isError 1 as failed', async () => {
    answer(
      ok([row(), row({ blockNumber: '101', hash: `0x${'A2'.repeat(32)}`, to: '', value: '0', isError: '1' })]),
      ok([
        { ...row({ blockNumber: '102', hash: `0x${'B1'.repeat(32)}`, value: '5' }), type: 'call' },
        {
          blockNumber: '103',
          timeStamp: '1700000300',
          transactionHash: `0x${'B2'.repeat(32)}`,
          from: FUNDER,
          to: WALLET,
          value: '7',
          isError: '0',
        },
      ]),
    );
    const explorer = source();
    const funder = FUNDER.toLowerCase();

    await expect(explorer.oldestTransfers(WALLET, END, 10)).resolves.toEqual({
      complete: true,
      transfers: [
        { hash: `0x${'a1'.repeat(32)}`, block: 100, time: 1700000000, from: funder, to: WALLET, valueWei: '1000000000000000000', failed: false, kind: 'external' },
        { hash: `0x${'a2'.repeat(32)}`, block: 101, time: 1700000000, from: funder, to: null, valueWei: '0', failed: true, kind: 'external' },
      ],
    });
    await expect(explorer.oldestInternalTransfers(WALLET, END, 10)).resolves.toEqual({
      complete: true,
      transfers: [
        { hash: `0x${'b1'.repeat(32)}`, block: 102, time: 1700000000, from: funder, to: WALLET, valueWei: '5', failed: false, kind: 'internal' },
        { hash: `0x${'b2'.repeat(32)}`, block: 103, time: 1700000300, from: funder, to: WALLET, valueWei: '7', failed: false, kind: 'internal' },
      ],
    });
  });

  it('turns "No transactions found" into an empty, complete page', async () => {
    answer(NOTHING);
    await expect(source().oldestTransfers(WALLET, END, 10)).resolves.toEqual({ transfers: [], complete: true });
  });

  it('marks a page incomplete when as many rows came back as the limit', async () => {
    answer(ok([row(), row({ blockNumber: '101', hash: `0x${'A2'.repeat(32)}` })]));
    const page = await source().oldestTransfers(WALLET, END, 2);
    expect(page.transfers).toHaveLength(2);
    expect(page.complete).toBe(false);
  });

  it('waits a second and retries when the explorer says it is rate limited, then returns the page', async () => {
    vi.useFakeTimers();
    answer({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' }, ok([row()]));
    const pending = source().oldestTransfers(WALLET, END, 10);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ complete: true, transfers: [{ block: 100 }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['status 2', { status: '2', message: 'Internal transactions for this range have not yet been processed', result: [] }],
    ['status 0 with an empty list', { status: '0', message: 'Block range has not yet been processed', result: [] }],
  ])('refuses an unindexed range (%s) with the fixed message, never an empty page', async (_label, body) => {
    answer(body);
    const failure = source().oldestInternalTransfers(WALLET, END, 10);
    await expect(failure).rejects.toBeInstanceOf(ExplorerError);
    await expect(failure).rejects.toThrow(/^internal transactions are not indexed for this block range$/);
  });

  it.each([
    ['a value that is not digits', row({ value: '1e18' })],
    ['a short hash', row({ hash: '0x1234' })],
    ['no hash at all', row({ hash: undefined })],
    ['a block past endBlock', row({ blockNumber: String(END + 1) })],
  ])('fails the whole call on a row with %s, and caches nothing', async (_label, bad) => {
    answer(ok([row(), bad]), ok([row()]));
    const explorer = source();
    await expect(explorer.oldestTransfers(WALLET, END, 10)).rejects.toThrow(ExplorerError);
    await expect(explorer.oldestTransfers(WALLET, END, 10)).resolves.toMatchObject({ transfers: [{ block: 100 }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('explorerSource cache', () => {
  it('serves a repeat call from the disk cache with no request, also after a restart', async () => {
    answer(ok([row()]));
    const first = await source().oldestTransfers(WALLET, END, 10);
    await expect(source().oldestTransfers(`0x${'AB'.repeat(20)}`, END, 10)).resolves.toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(cacheDir)).toEqual([`txlist-${END}-10.jsonl`]);
  });

  it('takes no rate-limit token for a cache hit', async () => {
    vi.useFakeTimers();
    answer(ok([row()]), NOTHING);
    const explorer = source(V2, KEY, 1);
    await explorer.oldestTransfers(WALLET, END, 10);
    await explorer.oldestTransfers(WALLET, END, 10);
    // At one call a second the next token is due at 1 s. Had the cache hit taken one, it would be due at 2 s.
    const next = explorer.oldestTransfers(OTHER, END, 10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(next).resolves.toEqual({ transfers: [], complete: true });
  });
});

describe('explorerSource errors (C40)', () => {
  it.each([
    ['an explorer that echoes the key', () => json({ status: '0', message: 'NOTOK', result: `Invalid API Key ${KEY}` })],
    ['a 403 whose body holds the key', () => json({ error: KEY }, 403)],
    ['a network error naming the URL', () => Promise.reject(new TypeError(`fetch failed: ${V2}?apikey=${KEY}`))],
    ['rate limits that never lift', () => json({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' })],
  ])('never puts the key or the URL in the message: %s', async (_label, reply) => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => reply());
    const pending = source().oldestTransfers(WALLET, END, 10).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toBeInstanceOf(ExplorerError);
    const message = (error as Error).message;
    expect(message).toContain(`txlist for ${WALLET}`);
    expect(message).not.toContain(KEY);
    expect(message).not.toMatch(/etherscan|apikey|https?:/i);
  });
});
