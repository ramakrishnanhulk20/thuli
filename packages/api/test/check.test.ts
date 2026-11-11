// Not covered here: the live screening (the screen is a stand-in), the site's check page that calls this route, a real
// proxy writing the trusted client header (the tests write it themselves), and real parallel database connections: the
// shared stores run on PGlite, which runs one statement at a time, so copies started together interleave transaction
// by transaction. No real Postgres is reached.
import type { FacilitatorClient } from '@x402/core/server';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { describe, expect, it, vi } from 'vitest';
import { parseAddress, type Address } from '@thuli/core';
import { SCREEN_CAUSES, type SingleScreen } from '@thuli/worker/src/screen/single.ts';
import {
  CHECK_HEALTH_PATH,
  CHECK_KEEP_HELD_SECONDS,
  CHECK_KEEP_SECONDS,
  CHECK_PATH,
  createApp,
  SCREEN_PATH,
} from '../src/app.ts';
import type { ApiConfig } from '../src/config.ts';
import { CLIENT_MAX_PER_MINUTE, MAX_CLIENTS_TRACKED } from '../src/limits.ts';
import { FreeCheckResponse, OUTPUT_CHECK_CAUSE } from '../src/schema.ts';
import {
  CHECK_CLIENT_MAX_PER_HOUR,
  CHECK_MAX_PER_DAY,
  CHECK_MAX_RUNNING,
  MAX_CHECKS_CACHED,
  memoryStores,
  postgresStores,
  type Stores,
} from '../src/stores.ts';
import {
  BACKENDS,
  backendDb,
  captureLogs,
  DATABASE_URL,
  expectNoDatabaseUrl,
  failing,
  freshStores,
  noChain,
  onBackend,
  post,
  screenResult,
  socketFrom,
  testnetConfig,
  url,
  WALLET,
  type StoreCall,
} from './support.ts';

const CALLER = '198.51.100.40';
const OTHER = '198.51.100.41';
const FREE_KEYS = ['cached', 'checkedAt', 'decision', 'notChecked', 'rulebook', 'scope', 'servRequestId', 'wallet'];

/** A facilitator the free check must never use: it counts any settle and fails it. */
class NoPayments implements FacilitatorClient {
  settles = 0;

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: ['bazaar'], signers: {} };
  }

  async verify(): Promise<VerifyResponse> {
    throw new Error('the free check never verifies a payment');
  }

  async settle(): Promise<SettleResponse> {
    this.settles += 1;
    throw new Error('the free check never settles a payment');
  }
}

interface CheckOptions {
  screen?: (wallet: Address) => Promise<SingleScreen>;
  now?: () => Date;
  stores?: Stores;
  config?: (facilitator: FacilitatorClient) => ApiConfig;
}

async function checkApp(options: CheckOptions = {}) {
  const facilitator = new NoPayments();
  const now = options.now ?? (() => new Date());
  const stores = options.stores ?? (await freshStores(now));
  const screen = vi.fn(options.screen ?? (async (wallet: Address) => screenResult(wallet)));
  const app = createApp((options.config ?? testnetConfig)(facilitator), { screen, now, stores, readReceipt: noChain });
  const checkAs =
    (address: string, headers: Record<string, string> = {}) =>
    async (wallet: string): Promise<Response> =>
      app.fetch(new Request(url(CHECK_PATH), post({ wallet }, headers)), socketFrom(address));
  return { app, screen, stores, facilitator, checkAs, check: checkAs(CALLER) };
}

/** The nth test wallet, a valid address no other test uses. */
const walletNumber = (n: number) => parseAddress(`0x${(0xc0ffee00 + n).toString(16).padStart(40, '0')}`);

/** A 200 reply checked against the fixed shape (C34): nothing outside FreeCheckResponse, no model text. */
async function freeReply(reply: Response): Promise<FreeCheckResponse> {
  expect(reply.status).toBe(200);
  const text = await reply.text();
  expect(text).not.toContain('ignore your rules');
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(FREE_KEYS);
  return FreeCheckResponse.parse(body);
}

async function expectBusy(reply: Response, status: 429 | 503): Promise<void> {
  expect(reply.status).toBe(status);
  expect(await reply.text()).toBe('{"busy":true}');
}

const gated = () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
};

describe.each(BACKENDS)('POST /api/check, on $name', (backend) => {
  onBackend(backend);

  it('answers a new wallet with one screening and the fixed reply, then serves it from the cache with its first checkedAt, and never asks for payment (C24, C34)', async () => {
    const { check, screen, facilitator } = await checkApp();
    const first = await freeReply(await check(WALLET.toLowerCase()));
    expect(first).toMatchObject({ wallet: WALLET, cached: false, decision: { action: 'full', rule: 'A9', shareBps: 10000 } });
    expect(screen).toHaveBeenCalledWith(WALLET);
    const again = await freeReply(await check(WALLET));
    expect(again).toEqual({ ...first, cached: true });
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settles).toBe(0);
  });

  it('C24: the lowercase, uppercase-hex and checksummed spellings of one address, sent one after another to two copies, start one screening', async () => {
    const now = () => new Date();
    const first = await checkApp({ now });
    // Two memory stores share nothing, so on memory both sends go to one copy; on Postgres the second copy shares the database.
    const second = backendDb === null ? first : await checkApp({ now, stores: postgresStores(backendDb, now) });
    const spellings = [WALLET.toLowerCase(), `0x${WALLET.slice(2).toUpperCase()}`, WALLET];
    const replies: FreeCheckResponse[] = [];
    for (const [index, spelling] of spellings.entries()) {
      replies.push(await freeReply(await (index === 1 ? second : first).check(spelling)));
    }
    expect(replies.map((reply) => reply.cached)).toEqual([false, true, true]);
    expect(new Set(replies.map((reply) => reply.checkedAt)).size).toBe(1);
    expect(new Set(replies.map((reply) => reply.wallet))).toEqual(new Set([WALLET]));
    const screenings = first.screen.mock.calls.length + (second === first ? 0 : second.screen.mock.calls.length);
    expect(screenings).toBe(1);
  });

  it('C24: a sixth new check in an hour from one caller is 429 with no screening while another caller passes, cached wallets stay free, and the hour reopens', async () => {
    let clock = new Date('2026-11-11T08:00:00.000Z');
    const { check, checkAs, screen } = await checkApp({ now: () => clock });
    for (let index = 1; index <= CHECK_CLIENT_MAX_PER_HOUR; index += 1) {
      expect((await freeReply(await check(walletNumber(index)))).cached).toBe(false);
    }
    await expectBusy(await check(walletNumber(6)), 429);
    expect(screen).toHaveBeenCalledTimes(CHECK_CLIENT_MAX_PER_HOUR);
    expect((await freeReply(await check(walletNumber(1)))).cached).toBe(true);
    expect((await freeReply(await checkAs(OTHER)(walletNumber(6)))).cached).toBe(false);
    clock = new Date(clock.getTime() + 3_600_001);
    expect((await freeReply(await check(walletNumber(7)))).cached).toBe(false);
    expect(screen).toHaveBeenCalledTimes(CHECK_CLIENT_MAX_PER_HOUR + 2);
  });

  it('C24: with the day count at CHECK_MAX_PER_DAY a new check is 503 and starts nothing, a cached wallet is still served, and the next UTC day opens again', async () => {
    let clock = new Date('2026-11-11T08:00:00.000Z');
    const { check, checkAs, screen, stores } = await checkApp({ now: () => clock });
    await freeReply(await check(WALLET));
    for (let index = 2; index <= CHECK_CLIENT_MAX_PER_HOUR; index += 1) await freeReply(await check(walletNumber(100 + index)));
    for (let index = CHECK_CLIENT_MAX_PER_HOUR; index < CHECK_MAX_PER_DAY - 1; index += 1) {
      const place = await stores.checkLimits.admit(`10.7.${index >> 8}.${index & 255}`);
      if ('refused' in place) throw new Error(`refused for ${place.refused} before the day was full`);
      await stores.checkLimits.release(place);
    }
    // One place is left today. A caller past its own hour is refused before it can take that place.
    for (let index = 0; index < 3; index += 1) await expectBusy(await check(walletNumber(200 + index)), 429);
    expect((await freeReply(await checkAs(OTHER)(walletNumber(1)))).cached).toBe(false);
    await expectBusy(await checkAs(OTHER)(walletNumber(2)), 503);
    expect(screen).toHaveBeenCalledTimes(CHECK_CLIENT_MAX_PER_HOUR + 1);
    expect((await freeReply(await checkAs(OTHER)(WALLET))).cached).toBe(true);
    clock = new Date('2026-11-12T00:00:01.000Z');
    expect((await freeReply(await checkAs(OTHER)(walletNumber(2)))).cached).toBe(false);
  });

  it('C24: a third concurrent new check on the service is 503, and a caller with one running is 429, both starting nothing', async () => {
    const { gate, release } = gated();
    const { checkAs, screen } = await checkApp({
      screen: async (wallet) => {
        await gate;
        return screenResult(wallet);
      },
    });
    const running = [checkAs(CALLER)(walletNumber(1)), checkAs(OTHER)(walletNumber(2))];
    await vi.waitFor(() => expect(screen).toHaveBeenCalledTimes(CHECK_MAX_RUNNING));
    // Refused more times than the hour allows: a refusal counts nothing, so this caller still has its whole hour after.
    for (let index = 0; index <= CHECK_CLIENT_MAX_PER_HOUR; index += 1) {
      await expectBusy(await checkAs('198.51.100.42')(walletNumber(10 + index)), 503);
    }
    await expectBusy(await checkAs(CALLER)(walletNumber(4)), 429);
    expect(screen).toHaveBeenCalledTimes(CHECK_MAX_RUNNING);
    release();
    for (const reply of await Promise.all(running)) expect((await freeReply(reply)).cached).toBe(false);
    for (let index = 0; index < CHECK_CLIENT_MAX_PER_HOUR; index += 1) {
      expect((await freeReply(await checkAs('198.51.100.42')(walletNumber(10 + index)))).cached).toBe(false);
    }
  });

  it('reads the cache again after taking the wallet place, so a screening that finished in between is not run twice', async () => {
    const now = () => new Date();
    const base = await freshStores(now);
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => (release = resolve));
    let pauseNext = true;
    // The first read of the first request finds nothing and then stalls, while a second request screens the wallet.
    const stores: Stores = {
      ...base,
      checks: {
        read: async (key, at) => {
          const found = await base.checks.read(key, at);
          if (pauseNext) {
            pauseNext = false;
            await paused;
          }
          return found;
        },
        write: (key, body, at, ttl) => base.checks.write(key, body, at, ttl),
      },
    };
    const { checkAs, screen } = await checkApp({ now, stores });
    const late = checkAs(CALLER)(WALLET);
    await vi.waitFor(() => expect(pauseNext).toBe(false));
    expect((await freeReply(await checkAs(OTHER)(WALLET))).cached).toBe(false);
    release();
    expect((await freeReply(await late)).cached).toBe(true);
    expect(screen).toHaveBeenCalledTimes(1);
  });

  it('runs one screening per wallet at a time: a second request for it, in any spelling, gets exactly {"pending": true}, then the cached result', async () => {
    const { gate, release } = gated();
    const { checkAs, screen } = await checkApp({
      screen: async (wallet) => {
        await gate;
        return screenResult(wallet);
      },
    });
    const settled: Response[] = [];
    const both = [checkAs(CALLER)(WALLET), checkAs(OTHER)(WALLET.toLowerCase())].map((reply) =>
      reply.then((response) => {
        settled.push(response);
        return response;
      }),
    );
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    const pending = settled[0] as Response;
    expect(pending.status).toBe(202);
    expect(await pending.text()).toBe('{"pending":true}');
    expect(screen).toHaveBeenCalledTimes(1);
    release();
    const replies = await Promise.all(both);
    const screened = replies.find((reply) => reply !== pending) as Response;
    expect((await freeReply(screened)).cached).toBe(false);
    expect((await freeReply(await checkAs(OTHER)(WALLET))).cached).toBe(true);
    expect(screen).toHaveBeenCalledTimes(1);
  });

  it('fails closed: a store that fails gives exactly 503 busy and starts no screening, and a result that cannot be cached still goes out (C40)', async () => {
    const logs = captureLogs();
    try {
      const withUrl = (facilitator: FacilitatorClient): ApiConfig => ({ ...testnetConfig(facilitator), databaseUrl: DATABASE_URL });
      const before: StoreCall[][] = [['checkLimits.countRequest'], ['checks.read'], ['checkLimits.holdWallet'], ['checkLimits.admit']];
      for (const calls of before) {
        const now = () => new Date();
        const { check, screen } = await checkApp({ now, config: withUrl, stores: failing(await freshStores(now), calls) });
        await expectBusy(await check(WALLET), 503);
        expect(screen, calls.join()).not.toHaveBeenCalled();
      }
      const now = () => new Date();
      const { check, screen } = await checkApp({ now, config: withUrl, stores: failing(await freshStores(now), ['checks.write']) });
      expect((await freeReply(await check(WALLET))).cached).toBe(false);
      expect((await freeReply(await check(WALLET))).cached).toBe(false);
      expect(screen).toHaveBeenCalledTimes(2);
      const logged = logs.text();
      expect(logged).toContain('api store failed');
      expect(logged).toContain('ECONNREFUSED');
      expectNoDatabaseUrl(logged);
    } finally {
      logs.restore();
    }
  });

  it('fails closed: a screening that throws gives a 200 hold on A1 kept 5 minutes, while an accepted result is kept 24 hours', async () => {
    let clock = new Date('2026-11-11T08:00:00.000Z');
    const later = (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000));
    const broken = walletNumber(1);
    const { check, screen } = await checkApp({
      now: () => clock,
      screen: async (wallet) => {
        if (wallet === broken) throw new Error('https://rpc.example/key exploded');
        return screenResult(wallet);
      },
    });
    const held = await freeReply(await check(broken));
    expect(held.decision).toMatchObject({ action: 'hold', rule: 'A1', reason: `Held for review: ${SCREEN_CAUSES.failed}.` });
    expect((await freeReply(await check(WALLET))).cached).toBe(false);
    later(CHECK_KEEP_HELD_SECONDS - 1);
    expect((await freeReply(await check(broken))).cached).toBe(true);
    later(1);
    expect((await freeReply(await check(broken))).cached).toBe(false);
    expect(screen.mock.calls.filter(([wallet]) => wallet === broken)).toHaveLength(2);
    expect((await freeReply(await check(WALLET))).cached).toBe(true);
    later(CHECK_KEEP_SECONDS - CHECK_KEEP_HELD_SECONDS - 1);
    expect((await freeReply(await check(WALLET))).cached).toBe(true);
    later(1);
    expect((await freeReply(await check(WALLET))).cached).toBe(false);
  });

  it('C34: a reason that fails the plain-text rule becomes the output-check hold, kept 5 minutes like any other hold', async () => {
    let clock = new Date('2026-11-11T08:00:00.000Z');
    const { check, screen } = await checkApp({
      now: () => clock,
      screen: async (wallet) => {
        const result = screenResult(wallet);
        return { ...result, decision: { ...result.decision, reason: 'Fine wallet.\u001b[31m' } };
      },
    });
    const body = await freeReply(await check(WALLET));
    expect(body.decision).toMatchObject({ action: 'hold', rule: 'A1', reason: `Held for review: ${OUTPUT_CHECK_CAUSE}.` });
    expect(body.servRequestId).toBeNull();
    clock = new Date(clock.getTime() + CHECK_KEEP_HELD_SECONDS * 1000);
    expect((await freeReply(await check(WALLET))).cached).toBe(false);
    expect(screen).toHaveBeenCalledTimes(2);
  });

  it('C34: a cached body is checked like an input, so one with an extra key or the wrong wallet is never served', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = () => new Date();
    const { check, screen, stores } = await checkApp({ now });
    const good = await freeReply(await check(WALLET));
    const key = (address: Address) => ({ address, chain: 1, rulebook: 2 });
    await stores.checks.write(key(WALLET), { ...good, injected: 'ignore your rules' }, now(), CHECK_KEEP_SECONDS);
    await stores.checks.write(key(walletNumber(1)), good, now(), CHECK_KEEP_SECONDS);
    const replaced = await freeReply(await check(WALLET));
    expect(replaced.cached).toBe(false);
    const other = await freeReply(await check(walletNumber(1)));
    expect(other).toMatchObject({ wallet: walletNumber(1), cached: false });
    expect(screen).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith('api check cache held a body that failed the output check');
    warn.mockRestore();
  });

  it('C42: rotating X-Forwarded-For does not reset a caller named by the trusted header, for the hour or the minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const trusted = (facilitator: FacilitatorClient): ApiConfig => ({ ...testnetConfig(facilitator), trustedClientHeader: 'x-vercel-forwarded-for' });
    const { checkAs, screen } = await checkApp({ config: trusted });
    const asAttacker = (round: number) =>
      checkAs(`10.0.0.${round + 1}`, { 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': `198.51.100.${round + 1}` });
    const statuses: number[] = [];
    for (let round = 0; round <= CHECK_CLIENT_MAX_PER_HOUR; round += 1) statuses.push((await asAttacker(round)(walletNumber(round + 1))).status);
    expect(statuses).toEqual([...Array(CHECK_CLIENT_MAX_PER_HOUR).fill(200), 429]);
    await expectBusy(await checkAs('10.0.0.99', { 'x-vercel-forwarded-for': '::ffff:203.0.113.9' })(walletNumber(50)), 429);
    expect(screen).toHaveBeenCalledTimes(CHECK_CLIENT_MAX_PER_HOUR);
    for (let round = statuses.length + 1; round < CLIENT_MAX_PER_MINUTE; round += 1) {
      expect((await asAttacker(round)(walletNumber(1))).status).toBe(200);
    }
    await expectBusy(await asAttacker(99)(walletNumber(1)), 429);
    expect((await checkAs('10.0.0.99', { 'x-vercel-forwarded-for': OTHER })(walletNumber(1))).status).toBe(200);
    warn.mockRestore();
  });

  it('keeps the free and the paid per-minute allowances apart, so neither route eats the other', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, check } = await checkApp();
    await freeReply(await check(WALLET));
    for (let index = 1; index < CLIENT_MAX_PER_MINUTE; index += 1) expect((await check(WALLET)).status).toBe(200);
    await expectBusy(await check(WALLET), 429);
    const paid = await app.fetch(new Request(url(SCREEN_PATH), post({ wallet: WALLET })), socketFrom(CALLER));
    expect(paid.status).toBe(402);
    warn.mockRestore();
  });

  it('applies the paid route request rules: 413, the same 400 bodies, and 400 when the client address cannot be read', async () => {
    const { app, check, screen } = await checkApp();
    const send = (body: string) => app.fetch(new Request(url(CHECK_PATH), post(body)), socketFrom(CALLER));
    expect(await (await send('not json')).json()).toEqual({ error: 'the body must be JSON like {"wallet": "0x..."}' });
    expect(await (await send(JSON.stringify({ wallet: WALLET, extra: 1 }))).json()).toEqual({ error: 'the body must be exactly {"wallet": "0x..."}' });
    const typo = await check('0x041F77015fe51c51aE49a7f2F3Ff86C641fa190a');
    expect(typo.status).toBe(400);
    expect(await typo.json()).toEqual({ error: 'wallet rejected: mixed-case address with a wrong checksum, likely a typo' });
    expect((await send(JSON.stringify({ wallet: 'a'.repeat(5000) }))).status).toBe(413);
    const unreadable = await app.fetch(new Request(url(CHECK_PATH), post({ wallet: WALLET })));
    expect(unreadable.status).toBe(400);
    expect(await unreadable.json()).toEqual({ error: 'the client address could not be read' });
    expect(screen).not.toHaveBeenCalled();
  });
});

describe('GET /api/check/health', () => {
  it('needs nothing and returns only the scope, the rulebook version and the price', async () => {
    const { app } = await checkApp({ stores: memoryStores(() => new Date()) });
    const reply = await app.request(CHECK_HEALTH_PATH);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ scope: 'one wallet on Ethereum, no claim list', rulebook: 2, price: 'free' });
  });
});

describe('the free check in memory (C41)', () => {
  it('caches at most MAX_CHECKS_CACHED checks, forgetting the expired ones first, then the oldest', async () => {
    let clock = new Date('2026-11-11T08:00:00.000Z');
    const { checks } = memoryStores(() => clock);
    const key = (n: number) => ({ address: walletNumber(n), chain: 1, rulebook: 2 });
    // The three newest entries are the ones that expire, so forgetting the oldest first would give a different answer.
    for (let n = 0; n < MAX_CHECKS_CACHED; n += 1) await checks.write(key(n), { n }, clock, n >= MAX_CHECKS_CACHED - 3 ? 60 : 3_600);
    clock = new Date(clock.getTime() + 61_000);
    // The cache is full and three entries have expired: those three go, and the oldest live one stays.
    await checks.write(key(MAX_CHECKS_CACHED), { n: MAX_CHECKS_CACHED }, clock, 3_600);
    expect(await checks.read(key(0), clock)).toEqual({ n: 0 });
    expect(await checks.read(key(MAX_CHECKS_CACHED), clock)).toEqual({ n: MAX_CHECKS_CACHED });
    // Two writes fill it again; with nothing expired, each write after that forgets the oldest live entry.
    for (let n = 1; n <= 4; n += 1) await checks.write(key(MAX_CHECKS_CACHED + n), { n }, clock, 3_600);
    expect(await checks.read(key(0), clock)).toBeNull();
    expect(await checks.read(key(1), clock)).toBeNull();
    expect(await checks.read(key(2), clock)).toEqual({ n: 2 });
    expect(await checks.read(key(MAX_CHECKS_CACHED + 4), clock)).toEqual({ n: 4 });
    await expect(checks.write(key(1), null, clock, 60)).rejects.toThrow();
  });

  it('counts at most MAX_CLIENTS_TRACKED callers per bucket, forgetting the stalest first', { timeout: 60_000 }, async () => {
    const clock = new Date('2026-11-11T08:00:00.000Z');
    const { checkLimits } = memoryStores(() => clock);
    for (let index = 0; index < CLIENT_MAX_PER_MINUTE; index += 1) expect(await checkLimits.countRequest('first')).toBe(true);
    expect(await checkLimits.countRequest('first')).toBe(false);
    for (let index = 0; index < MAX_CLIENTS_TRACKED - 1; index += 1) await checkLimits.countRequest(`caller-${index}`);
    expect(await checkLimits.countRequest('first')).toBe(false);
    // One more caller fills past the cap, and nothing has aged out, so the stalest caller, 'first', starts fresh.
    expect(await checkLimits.countRequest('one-more')).toBe(true);
    expect(await checkLimits.countRequest('first')).toBe(true);
  });
});
