import fs from 'node:fs';
import { z } from 'zod';
import { graphVersion, parseAddress, type Address } from '@thuli/core';
import { BASE_PUBLIC_RPC_URL, BLOCKSCOUT_BASE_API_DEFAULT, BLOCKSCOUT_KEY } from '../env.ts';

export class WorkerConfigError extends Error {
  override name = 'WorkerConfigError';
}

/** Everything npm run worker reads from the environment, checked. */
export interface WorkerConfig {
  databaseUrl: string;
  workerKey: `0x${string}`;
  servApiKey: string;
  servBaseUrl: string;
  servGraphId: string;
  ethRpcUrl: string;
  blockscoutApi: string;
  /** Base mainnet's RPC for screening on Base history: BASE_RPC_URL, or Base's public endpoint when it is not set. */
  baseRpcUrl: string;
  /** Base mainnet's Blockscout API: BLOCKSCOUT_BASE_API, or Blockscout's keyed API for chain 8453 when it is not set. */
  blockscoutBaseApi: string;
  /** The Blockscout API key, sent only to Base's Blockscout. null when BLOCKSCOUT_API_KEY is not set: Base history is off. */
  blockscoutApiKey: string | null;
  /** The campaign chain's RPC: Base Sepolia, where every campaign vault lives today. */
  chainRpcUrl: string;
  /** The outside check for appeals; null when REPPO_API_KEY is not set, and the appeal step is then skipped. */
  reppo: { apiKey: string; baseUrl: string } | null;
}

/** The factory every campaign vault comes from and the block it was deployed in, from the deployment record. */
export interface FactoryRecord {
  address: Address;
  block: bigint;
}

const KEY = /^0x[0-9a-fA-F]{64}$/;
const LOCAL_FORK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const MAX_DEPLOYMENT_BYTES = 64 * 1024;
// A value shorter than this is never scrubbed from a line, so a near-empty variable cannot blank out ordinary words.
const MIN_SECRET_CHARS = 8;

function isHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

const RULES: readonly { name: string; valid(value: string): boolean; needs: string }[] = [
  { name: 'DATABASE_URL', valid: (value) => /^postgres(ql)?:\/\/\S+$/.test(value), needs: 'a postgres:// or postgresql:// connection string' },
  { name: 'WORKER_PRIVATE_KEY', valid: (value) => KEY.test(value), needs: '0x and 64 hex characters: the agent key the campaign vault names' },
  { name: 'SERV_API_KEY', valid: (value) => value.length > 0, needs: 'the SERV API key' },
  { name: 'SERV_BASE_URL', valid: isHttps, needs: 'an https URL' },
  {
    name: 'SERV_GRAPH_ID',
    valid: (value) => /^gr_\S+$/.test(value) && graphVersion(value) !== undefined,
    needs: 'a graph id starting gr_ that Thuli has a translation for',
  },
  { name: 'ETH_RPC_URL', valid: isHttps, needs: 'an https URL' },
  { name: 'BLOCKSCOUT_ETH_API', valid: isHttps, needs: 'an https URL' },
  {
    name: 'BASE_SEPOLIA_RPC_URL',
    valid: (value) => isHttps(value) || LOCAL_FORK.test(value),
    needs: 'an https URL, or http://127.0.0.1:PORT for a local fork',
  },
];

// Read only when REPPO_API_KEY is set: https only, because the key travels as a bearer header.
const REPPO_BASE_URL = { name: 'REPPO_BASE_URL', valid: isHttps, needs: 'an https URL, since REPPO_API_KEY is set' };

// Names that may be left unset, each then taking its default. env.ts checks the same three names by the same rules, so a
// value one of them refuses the other refuses too. https only: the Blockscout key travels as a bearer header.
const DEFAULTED: readonly { name: string; valid(value: string): boolean; needs: string; fallback: string }[] = [
  { name: 'BASE_RPC_URL', valid: isHttps, needs: "an https URL, or unset for Base's public endpoint", fallback: BASE_PUBLIC_RPC_URL },
  {
    name: 'BLOCKSCOUT_BASE_API',
    valid: isHttps,
    needs: "an https URL, or unset for Blockscout's API on Base",
    fallback: BLOCKSCOUT_BASE_API_DEFAULT,
  },
  {
    name: 'BLOCKSCOUT_API_KEY',
    valid: (value) => BLOCKSCOUT_KEY.test(value),
    needs: '8 to 512 visible characters with no spaces, or unset to screen on Ethereum only',
    fallback: '',
  },
];

/**
 * Reads and checks every variable the worker needs before anything connects, so a missing one stops it at start rather
 * than at its first screening. Base URLs lose any trailing slash, as env.ts does. REPPO_API_KEY is optional: without it
 * the appeal step is skipped; with it, REPPO_BASE_URL must be an https URL. BASE_RPC_URL and BLOCKSCOUT_BASE_API are
 * optional, each with its default, and BLOCKSCOUT_API_KEY is optional: without it Base history is off.
 *
 * @throws WorkerConfigError naming each missing or invalid variable on its own line, with what it must be. No value is
 *   ever part of the message (C40).
 */
export function loadWorkerConfig(source: Record<string, string | undefined>): WorkerConfig {
  const read = (name: string) => (source[name] ?? '').trim();
  const reppoKey = read('REPPO_API_KEY');
  const problems: string[] = [];
  for (const rule of reppoKey === '' ? RULES : [...RULES, REPPO_BASE_URL]) {
    const value = read(rule.name);
    if (value === '') problems.push(`${rule.name} is missing: it must be ${rule.needs}`);
    else if (!rule.valid(value)) problems.push(`${rule.name} is not valid: it must be ${rule.needs}`);
  }
  for (const rule of DEFAULTED) {
    const value = read(rule.name);
    if (value !== '' && !rule.valid(value)) problems.push(`${rule.name} is not valid: it must be ${rule.needs}`);
  }
  if (problems.length > 0) {
    throw new WorkerConfigError(
      ['The worker cannot start. Set these in .env (see .env.example):', ...problems.map((line) => `  ${line}`)].join('\n'),
    );
  }
  const url = (name: string) => read(name).replace(/\/+$/, '');
  const urlOr = (name: string, fallback: string) => (read(name) === '' ? fallback : url(name));
  const blockscoutKey = read('BLOCKSCOUT_API_KEY');
  return {
    databaseUrl: read('DATABASE_URL'),
    workerKey: read('WORKER_PRIVATE_KEY') as `0x${string}`,
    servApiKey: read('SERV_API_KEY'),
    servBaseUrl: url('SERV_BASE_URL'),
    servGraphId: read('SERV_GRAPH_ID'),
    ethRpcUrl: url('ETH_RPC_URL'),
    blockscoutApi: url('BLOCKSCOUT_ETH_API'),
    baseRpcUrl: urlOr('BASE_RPC_URL', BASE_PUBLIC_RPC_URL),
    blockscoutBaseApi: urlOr('BLOCKSCOUT_BASE_API', BLOCKSCOUT_BASE_API_DEFAULT),
    blockscoutApiKey: blockscoutKey === '' ? null : blockscoutKey,
    chainRpcUrl: url('BASE_SEPOLIA_RPC_URL'),
    reppo: reppoKey === '' ? null : { apiKey: reppoKey, baseUrl: url('REPPO_BASE_URL') },
  };
}

const DeploymentFile = z.object({ chainId: z.literal(84532), factory: z.string(), block: z.int().positive() });

/**
 * The factory every campaign vault comes from, read from the deployment record npm run vault:deploy writes.
 *
 * @throws WorkerConfigError when the file is missing, too large, or not a Base Sepolia deployment record.
 */
export function readFactoryRecord(file: string): FactoryRecord {
  if (!fs.existsSync(file) || fs.statSync(file).size > MAX_DEPLOYMENT_BYTES) {
    throw new WorkerConfigError(`No usable deployment record at ${file}. Run npm run vault:deploy first.`);
  }
  let parsed: z.infer<typeof DeploymentFile>;
  try {
    parsed = DeploymentFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { address: parseAddress(parsed.factory), block: BigInt(parsed.block) };
  } catch {
    throw new WorkerConfigError(`The deployment record at ${file} is not a Base Sepolia factory record.`);
  }
}

/**
 * A function that blanks every given secret out of a log line, in any letter case, before it is printed. Thuli's own
 * lines never hold one; this is the last guard for a library message that quotes a URL or a key (C39, C40).
 */
export function scrubber(secrets: readonly string[]): (line: string) => string {
  const patterns = [...new Set(secrets.map((secret) => secret.trim()).filter((secret) => secret.length >= MIN_SECRET_CHARS))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  return (line) => patterns.reduce((clean, pattern) => clean.replace(pattern, '[hidden]'), line);
}

/**
 * The values of a worker config that must never reach a log: the key in both spellings, the SERV, Reppo and Blockscout
 * keys and every URL.
 */
export function secretsOf(config: WorkerConfig): string[] {
  const secrets = [config.workerKey, config.workerKey.slice(2), config.servApiKey, config.databaseUrl];
  secrets.push(config.ethRpcUrl, config.blockscoutApi, config.baseRpcUrl, config.blockscoutBaseApi, config.chainRpcUrl);
  if (config.reppo !== null) secrets.push(config.reppo.apiKey);
  if (config.blockscoutApiKey !== null) secrets.push(config.blockscoutApiKey);
  try {
    const password = decodeURIComponent(new URL(config.databaseUrl).password);
    if (password !== '') secrets.push(password);
  } catch {
    // connectPostgres refuses a URL it cannot read, before any line could quote it.
  }
  return secrets;
}
