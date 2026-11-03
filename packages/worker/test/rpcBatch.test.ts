// Not covered here: a live node (every reply is a stub and no request leaves the machine), real provider batch-size
// limits, whether the node keeps state for old blocks, and replies too large for the size cap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/chain/rateLimiter.ts';
import { accountStates } from '../src/chain/rpcBatch.ts';

const RPC = 'https://rpc.example.org/v2/SECRETRPCKEY';
const BLOCK = 18_000_000;
const BLOCK_HEX = `0x${BLOCK.toString(16)}`;
const A = `0x${'0a'.repeat(20)}`;
const B = `0x${'0b'.repeat(20)}`;
const C = `0x${'0c'.repeat(20)}`;

interface Call {
  jsonrpc: string;
  id: number;
  method: string;
  params: [string, string];
}

let cacheDir: string;
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
  throw new Error('unexpected request');
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const nonceOf = (address: string) => Number(BigInt(address) % 1000n);
const codeOf = (address: string) => (BigInt(address) % 2n === 0n ? '0x' : '0x6080');

/** A stand-in node that answers in reverse order, so states only line up if they are matched by id. */
function node(opts: { codeErrorFor?: string } = {}) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const calls = JSON.parse(String(init?.body)) as Call[];
    const items = calls.map(({ id, method, params: [address] }) => {
      if (method === 'eth_getCode' && address === opts.codeErrorFor) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } };
      }
      const result = method === 'eth_getTransactionCount' ? `0x${nonceOf(address).toString(16)}` : codeOf(address);
      return { jsonrpc: '2.0', id, result };
    });
    return json(items.reverse());
  };
}

function sentCalls(): Call[][] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Call[]);
}

function sentAddresses(): string[] {
  return sentCalls().flatMap((calls) => calls.filter((call) => call.method === 'eth_getCode').map((call) => call.params[0]));
}

function reader(batchSize?: number) {
  return accountStates({ rpcUrl: RPC, perSecond: 1000, cacheDir, batchSize });
}

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-rpc-'));
  fetchMock.mockReset();
  fetchMock.mockImplementation(node());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('accountStates', () => {
  it('de-duplicates, splits at batchSize, and asks for nonce and code at the block in hex', async () => {
    const mixed = `0x${'AB'.repeat(20)}`;
    const wanted = [A, B, mixed, C, `0x${'0d'.repeat(20)}`];
    const states = await reader(2).read([...wanted, A, mixed.toLowerCase()], BLOCK);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentCalls().map((calls) => calls.length)).toEqual([4, 4, 2]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(RPC);
      expect(init?.method).toBe('POST');
    }
    expect(sentCalls()[0]).toEqual([
      { jsonrpc: '2.0', id: 0, method: 'eth_getTransactionCount', params: [A, BLOCK_HEX] },
      { jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [A, BLOCK_HEX] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionCount', params: [B, BLOCK_HEX] },
      { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params: [B, BLOCK_HEX] },
    ]);

    const lower = wanted.map((address) => address.toLowerCase());
    expect([...states.keys()]).toEqual(lower);
    for (const address of lower) {
      expect(states.get(address)).toEqual({ nonce: nonceOf(address), code: codeOf(address) });
    }
  });

  it('does not send cached addresses again, also after a restart', async () => {
    await reader().read([A, B], BLOCK);
    fetchMock.mockClear();

    const states = await reader().read([A, B, C], BLOCK);
    expect(sentAddresses()).toEqual([C]);
    expect(states.get(A)).toEqual({ nonce: nonceOf(A), code: codeOf(A) });
    expect(states.get(C)).toEqual({ nonce: nonceOf(C), code: codeOf(C) });
  });

  it('makes a field null on a per-item error and does not cache that address', async () => {
    fetchMock.mockImplementation(node({ codeErrorFor: B }));
    const states = await reader().read([A, B], BLOCK);
    expect(states.get(A)).toEqual({ nonce: nonceOf(A), code: codeOf(A) });
    expect(states.get(B)).toEqual({ nonce: nonceOf(B), code: null });

    fetchMock.mockClear();
    fetchMock.mockImplementation(node());
    const retried = await reader().read([A, B], BLOCK);
    expect(sentAddresses()).toEqual([B]);
    expect(retried.get(B)).toEqual({ nonce: nonceOf(B), code: codeOf(B) });
  });

  it('retries a batch that fails as a whole five times, then leaves it null without throwing', async () => {
    vi.useFakeTimers();
    const failures: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError(`fetch failed: ${RPC}`)),
      async () => json({ error: 'busy' }, 503),
      async () => json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch too large' } }),
      async () => json([]),
      async () => json({ error: 'slow down' }, 429),
      async () => new Response('<html>bad gateway</html>', { status: 200 }),
    ];
    for (const failure of failures) fetchMock.mockImplementationOnce(failure);

    const pending = reader().read([A, B], BLOCK);
    await vi.runAllTimersAsync();
    const states = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(states.get(A)).toEqual({ nonce: null, code: null });
    expect(states.get(B)).toEqual({ nonce: null, code: null });

    vi.useRealTimers();
    fetchMock.mockClear();
    await reader().read([A, B], BLOCK);
    expect(sentAddresses()).toEqual([A, B]);
  });

  it('gives up at once on a refused request (4xx other than 429), so a wrong key costs one call, not half a minute', async () => {
    for (const status of [400, 401, 403, 413]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => json({ error: 'refused' }, status));
      const states = await reader().read([A, B], BLOCK);
      expect(fetchMock, String(status)).toHaveBeenCalledTimes(1);
      expect(states.get(A)).toEqual({ nonce: null, code: null });
      expect(states.get(B)).toEqual({ nonce: null, code: null });
    }
  });
});

describe('RateLimiter', () => {
  it('lets 10 calls through at 5 a second over no less than 1.8 s, never more than 5 in one second', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(5);
    const start = performance.now();
    const times: number[] = [];
    const all = Promise.all(Array.from({ length: 10 }, () => limiter.take().then(() => times.push(performance.now() - start))));
    await vi.runAllTimersAsync();
    await all;

    expect(Math.max(...times)).toBeGreaterThanOrEqual(1800);
    for (const from of times) {
      expect(times.filter((t) => t >= from && t < from + 1000).length).toBeLessThanOrEqual(5);
    }
  });
});
