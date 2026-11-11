import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AddressError, parseAddress, type Address } from '@thuli/core';
import { EnvError } from '@thuli/worker/src/env.ts';
import { createApp, SCREEN_PATH } from '../src/app.ts';
import { ConfigError, loadApiConfig, PRICE_UNITS, type ApiConfig } from '../src/config.ts';
import { liveScreen } from '../src/live.ts';
import { PaidScreenResponse } from '../src/schema.ts';
import { PayerKeyError, takePayerAccount } from './payer-key.ts';

const ROBO_FARM_WALLET = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';
const USAGE = 'Usage: npm run prove:paid -- [--wallet <address>] [--url <http origin of a running site>] [--save <file for the 200 body>]';
const REPLAYS = 10;
const RPC_TIMEOUT_MS = 15_000;
// The screening's own limit is 2 minutes; settlement and the reply fit in the rest (C41).
const REQUEST_TIMEOUT_MS = 180_000;
const BALANCE_WAIT_MS = 15_000;

class UsageError extends Error {
  override name = 'UsageError';
}

interface Options {
  wallet: Address;
  /** The origin of a site already serving the paid route, such as http://localhost:3300. Null runs the API in this process. */
  origin: string | null;
  /** Where to write the 200 body, exactly as received. */
  save: string | null;
}

function readOptions(): Options {
  let values: { wallet?: string | undefined; url?: string | undefined; save?: string | undefined };
  try {
    values = parseArgs({
      options: { wallet: { type: 'string' }, url: { type: 'string' }, save: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new UsageError(USAGE);
  }
  let wallet: Address;
  try {
    wallet = parseAddress(values.wallet ?? ROBO_FARM_WALLET);
  } catch (error) {
    throw new UsageError(`Wallet address rejected: ${error instanceof AddressError ? error.message : 'unreadable'}`);
  }
  let origin: string | null = null;
  if (values.url !== undefined) {
    // An origin and nothing else, so the request goes to the paid route's own path and no query or credential rides along.
    const parsed = URL.canParse(values.url) ? new URL(values.url) : null;
    const bare = parsed !== null && parsed.pathname === '/' && parsed.search === '' && parsed.username === '' && parsed.password === '';
    if (parsed === null || !bare || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new UsageError('--url must be an http or https origin with no path, such as http://localhost:3300.');
    }
    origin = parsed.origin;
  }
  return { wallet, origin, save: values.save ?? null };
}

function usdc(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const whole = units < 0n ? -units : units;
  return `${sign}${whole / 1_000_000n}.${(whole % 1_000_000n).toString().padStart(6, '0')} USDC`;
}

/**
 * A balance reader on the payment's own chain: BASE_RPC_URL on Base mainnet, the public Sepolia RPC on Base Sepolia.
 * An RPC that answers for any other chain is refused before anything is paid (C2).
 */
async function balanceReader(config: ApiConfig, payer: Address): Promise<() => Promise<bigint>> {
  const rpcName = config.network === 'base' ? 'BASE_RPC_URL' : config.settlementRpcUrl;
  const client = createPublicClient({ transport: http(config.settlementRpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }), ccipRead: false });
  const chainId = await client.getChainId();
  if (chainId !== config.chainId) {
    throw new UsageError(`${rpcName} answers for chain ${chainId}, but X402_NETWORK is ${config.network} (chain ${config.chainId}).`);
  }
  return () => client.readContract({ address: config.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [payer] });
}

/** Pays only our exact terms: this network, its canonical USDC, our payTo, exactly the price. Anything else is not paid (C22). */
function payingClient(config: ApiConfig, account: ReturnType<typeof privateKeyToAccount>): x402Client {
  const sameAddress = (value: string, expected: Address) => {
    try {
      return parseAddress(value) === expected;
    } catch {
      return false;
    }
  };
  return new x402Client()
    .register(config.networkId, new ExactEvmScheme(account))
    .registerPolicy((_version, requirements) =>
      requirements.filter(
        (offer) =>
          offer.scheme === 'exact' &&
          offer.network === config.networkId &&
          offer.amount === PRICE_UNITS &&
          sameAddress(offer.asset, config.usdc) &&
          sameAddress(offer.payTo, config.payTo),
      ),
    )
    .setSpendControls({ maxAmountPerPayment: '$0.05' });
}

async function listen(config: ApiConfig): Promise<{ origin: string; close(): void }> {
  const app = createApp(config, { screen: liveScreen(process.env) });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      resolve({ origin: `http://127.0.0.1:${info.port}`, close: () => server.close() });
    });
    server.once('error', reject);
  });
}

async function waitForChange(read: () => Promise<bigint>, before: bigint): Promise<bigint> {
  const deadline = Date.now() + BALANCE_WAIT_MS;
  let now = await read();
  while (now === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    now = await read();
  }
  return now;
}

async function main(): Promise<number> {
  const { wallet, origin, save } = readOptions();
  // The API runs in this process, so the payer key leaves the environment before the API reads it (C39).
  const account = takePayerAccount(process.env);
  const config = loadApiConfig(process.env);
  const payer = parseAddress(account.address);
  const readBalance = await balanceReader(config, payer);
  const before = await readBalance();

  console.log(`network:          ${config.networkId}`);
  console.log(`payer:            ${payer}`);
  console.log(`payer USDC before: ${usdc(before)}`);
  if (before < BigInt(PRICE_UNITS)) {
    console.error(`The payer needs at least ${usdc(BigInt(PRICE_UNITS))}. Nothing was paid.`);
    if (config.network === 'base-sepolia') console.error('Free test USDC: https://faucet.circle.com/, choose Base Sepolia.');
    return 3;
  }

  // A running site is paid as any buyer would pay it; it must be configured with the same network and payTo as this env.
  const server = origin === null ? await listen(config) : { origin, close: () => undefined };
  console.log(`paid route at:    ${server.origin}${SCREEN_PATH}`);
  try {
    let sentSignature: string | null = null;
    const recordingFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      sentSignature = request.headers.get('payment-signature') ?? sentSignature;
      return fetch(request, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    };
    const client = payingClient(config, account);
    const pay = wrapFetchWithPayment(recordingFetch, client);
    const target = `${server.origin}${SCREEN_PATH}`;
    const body = JSON.stringify({ wallet });

    const response = await pay(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const outcome = await new x402HTTPClient(client).processResponse(response);
    console.log(`wallet screened:  ${wallet}`);
    if (outcome.status !== 200 || outcome.paymentStatus !== 'settled') {
      console.error(`The paid call did not return a result: status ${outcome.status}, payment ${outcome.paymentStatus}.`);
      // The reason is a fixed code. The message beside it can quote a contract call or an RPC URL, so it is not printed.
      const header = response.headers.get('payment-response');
      const reason = header === null ? 'none given' : (decodePaymentResponseHeader(header).errorReason ?? 'none given');
      console.error(`reason:           ${reason}`);
      return 1;
    }
    const result = PaidScreenResponse.parse(outcome.body);
    // The body as it arrived, once it has passed the reply's own schema; nothing is added or reordered.
    if (save !== null) fs.writeFileSync(save, `${JSON.stringify(outcome.body, null, 2)}\n`);
    const { decision, payment } = result;
    console.log(`decision:         ${decision.action}, rule ${decision.rule}, share ${decision.shareBps} bps`);
    console.log(`reason:           ${decision.reason}`);
    console.log(`SERV request id:  ${result.servRequestId ?? 'none'}`);
    console.log(`settlement tx:    ${payment.transaction}`);
    console.log(`explorer:         ${config.explorer}/tx/${payment.transaction}`);

    if (sentSignature === null) {
      console.error('The payment header that was sent could not be read back, so the replay was not tried.');
      return 1;
    }
    const replayHeader: string = sentSignature;
    const replays = await Promise.all(
      Array.from({ length: REPLAYS }, () =>
        fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': replayHeader },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      ),
    );
    const statuses = replays.map((reply) => reply.status);
    const replayed = statuses.filter((status) => status === 200).length;
    console.log(`replays:          ${REPLAYS} copies of the same payment header, ${replayed} returned 200 (must be 0); statuses ${statuses.join(' ')}`);

    const after = await waitForChange(readBalance, before);
    const spent = before - after;
    console.log(`payer USDC after: ${usdc(after)} (spent ${usdc(spent)}, price ${usdc(BigInt(PRICE_UNITS))})`);
    return replayed === 0 && spent === BigInt(PRICE_UNITS) && payment.payer === payer ? 0 : 1;
  } finally {
    server.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof PayerKeyError || error instanceof ConfigError || error instanceof EnvError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    // Library errors can quote an RPC URL that carries a key, so only the class name is printed. No key is ever printed (C40).
    console.error(`prove-paid stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  },
);
