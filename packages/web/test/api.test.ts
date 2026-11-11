// Covers the API mounted inside the site: the two route files, lib/server/thuliApi.ts and the API's site entry, called
// the way Next.js calls a route handler. Not covered: Next's own server and build (the built site is proven by a live
// run), a real Postgres, Vercel's header, SERV, the chain and the facilitator. No test here reaches a network, so the
// answers that need one (402 terms, 202 pending, a screening's 200) are covered by the API's own tests instead.
import { afterEach, describe, expect, it, vi } from 'vitest';

const SETTINGS: Record<string, string> = {
  X402_NETWORK: 'base-sepolia',
  PAYTO_ADDRESS_TESTNET: '0x2222222222222222222222222222222222222222',
  SERV_API_KEY: 'serv-key-that-is-never-sent',
  SERV_GRAPH_ID: 'gr_bc6116b0153f023d',
  SERV_BASE_URL: 'https://serv.invalid/v1',
  ETH_RPC_URL: 'https://rpc.invalid',
  BLOCKSCOUT_ETH_API: 'https://blockscout.invalid/api/v2',
  FACILITATOR_URL: '',
  PUBLIC_ORIGIN: '',
  DATABASE_URL: '',
  TRUSTED_CLIENT_HEADER: '',
};
const SECRET = '0x5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed';
const DATABASE_URL = 'postgres://thuli:hunter2-db-secret@db.internal.example:5432/thuli';
const SITE = 'http://localhost:3300';

/** Fresh route modules over this environment, so each test builds its own API the way a new server copy would. */
async function mount(env: Record<string, string>) {
  vi.resetModules();
  // A blank value is how every reader here treats a missing one, so any key the shell carries is blanked out first.
  for (const name of Object.keys(process.env)) if (/PRIVATE_KEY$/i.test(name)) vi.stubEnv(name, '');
  for (const [name, value] of Object.entries({ ...SETTINGS, ...env })) vi.stubEnv(name, value);
  const x402 = await import('../app/api/x402/[...path]/route');
  const check = await import('../app/api/check/[[...path]]/route');
  const send = (path: string, init: RequestInit = {}, caller: string | null = '198.51.100.7') => {
    const headers = new Headers(init.headers);
    if (caller !== null) headers.set('x-forwarded-for', caller);
    const request = new Request(`${SITE}${path}`, { ...init, headers });
    const route = path.startsWith('/api/x402') ? x402 : check;
    return request.method === 'POST' ? route.POST(request) : route.GET(request);
  };
  return { x402, check, send };
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

function captureLogs() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return {
    warns: () => warn.mock.calls.map((call) => String(call[0])),
    errors: () => error.mock.calls.map((call) => String(call[0])),
    text: () => JSON.stringify([...warn.mock.calls, ...error.mock.calls]),
  };
}

async function expectBusy(reply: Response): Promise<void> {
  expect(reply.status).toBe(503);
  expect(await reply.text()).toBe('{"busy":true}');
  expect(reply.headers.get('cache-control')).toBe('no-store');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// The first mount imports the whole API (x402, viem, the CDP SDK) cold, which takes seconds when the full suite runs.
describe('the API mounted in the site', { timeout: 30_000 }, () => {
  it('declares both route files as dynamic Node.js handlers allowed 300 seconds', async () => {
    const { x402, check } = await mount({ NODE_ENV: 'test' });
    for (const route of [x402, check]) {
      expect(route).toMatchObject({ runtime: 'nodejs', dynamic: 'force-dynamic', maxDuration: 300 });
      expect(typeof route.GET).toBe('function');
      expect(typeof route.POST).toBe('function');
    }
  });

  it('outside production, serves both routes from an in-process database with the bundled rulebook and migrations, warning once', async () => {
    const logs = captureLogs();
    const { send } = await mount({ NODE_ENV: 'test' });
    const paidHealth = await send('/api/x402/health');
    expect(paidHealth.status).toBe(200);
    expect(await paidHealth.json()).toMatchObject({ network: 'eip155:84532', price: '$0.05' });
    const freeHealth = await send('/api/check/health');
    expect(await freeHealth.json()).toEqual({ scope: 'one wallet on Ethereum, no claim list', rulebook: 2, price: 'free' });
    // The per-minute allowance is counted in the in-process database, so the 21st request in a minute is refused.
    const statuses: number[] = [];
    for (let index = 0; index <= 20; index += 1) statuses.push((await send('/api/check', postJson({}))).status);
    expect(statuses).toEqual([...Array(20).fill(400), 429]);
    expect(logs.warns().filter((line) => line.includes('lost on restart'))).toHaveLength(1);
    expect(logs.errors()).toEqual([]);
  });

  it('marks every answer it gives cache-control: no-store, whatever its status', async () => {
    captureLogs();
    const { send } = await mount({ NODE_ENV: 'test' });
    const replies = [
      await send('/api/x402/health'),
      await send('/api/check/health'),
      await send('/api/x402/no-such-route'),
      await send('/api/check', postJson('not json')),
      await send('/api/check', postJson({ wallet: 'a'.repeat(5000) })),
      await send('/api/check', postJson({ wallet: '0x041F77015fe51c51aE49a7f2F3Ff86C641fa190a' })),
      await send('/api/x402/screen', postJson({ wallet: '0x041f77015fe51c51ae49a7f2f3ff86c641fa190a' }), null),
    ];
    for (let index = 0; index <= 20; index += 1) replies.push(await send('/api/x402/screen', postJson('x'), '198.51.100.8'));
    const refused = await mount({ NODE_ENV: 'production' });
    replies.push(await refused.send('/api/x402/health'), await refused.send('/api/check', postJson({})));
    expect(new Set(replies.map((reply) => reply.status))).toEqual(new Set([200, 400, 404, 413, 429, 503]));
    for (const reply of replies) expect(reply.headers.get('cache-control'), String(reply.status)).toBe('no-store');
  });

  it('answers 503 busy on both routes while a private key is in the environment, and logs its name once, never its value (C39, C40)', async () => {
    const logs = captureLogs();
    const { send } = await mount({ NODE_ENV: 'test', DEMO_PRIVATE_KEY: SECRET });
    await expectBusy(await send('/api/x402/health'));
    await expectBusy(await send('/api/check/health'));
    await expectBusy(await send('/api/check', postJson({ wallet: '0x041f77015fe51c51ae49a7f2f3ff86c641fa190a' })));
    expect(logs.errors()).toHaveLength(1);
    expect(logs.errors()[0]).toContain('DEMO_PRIVATE_KEY');
    expect(logs.text()).not.toContain(SECRET.slice(2));
  });

  it('in production answers 503 busy without DATABASE_URL, and without TRUSTED_CLIENT_HEADER, naming the variable and connecting to nothing', async () => {
    const logs = captureLogs();
    const noDatabase = await mount({ NODE_ENV: 'production', TRUSTED_CLIENT_HEADER: 'x-vercel-forwarded-for' });
    await expectBusy(await noDatabase.send('/api/x402/health'));
    await expectBusy(await noDatabase.send('/api/check/health'));
    const noHeader = await mount({ NODE_ENV: 'production', DATABASE_URL });
    await expectBusy(await noHeader.send('/api/x402/health'));
    await expectBusy(await noHeader.send('/api/check', postJson({})));
    expect(logs.errors()).toHaveLength(2);
    expect(logs.errors()[0]).toContain('DATABASE_URL is not set');
    expect(logs.errors()[1]).toContain('TRUSTED_CLIENT_HEADER is not set');
    expect(logs.text()).not.toContain('hunter2');
    expect(logs.text()).not.toContain('db.internal.example');
  });

  it('answers 503 busy for a missing or malformed setting, naming it and never printing a value', async () => {
    const logs = captureLogs();
    const brokenSettings: Record<string, string>[] = [
      { SERV_API_KEY: '' },
      { X402_NETWORK: 'base-mainnet' },
      { DATABASE_URL: 'mysql://thuli:hunter2-db-secret@db.internal.example/thuli' },
    ];
    for (const broken of brokenSettings) {
      const { send } = await mount({ NODE_ENV: 'test', ...broken });
      await expectBusy(await send('/api/check/health'));
    }
    const errors = logs.errors();
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('SERV_API_KEY');
    expect(errors[1]).toContain('X402_NETWORK');
    expect(errors[2]).toContain('DATABASE_URL');
    expect(logs.text()).not.toContain('hunter2');
    expect(logs.text()).not.toContain('serv-key-that-is-never-sent');
  });
});
