// Not covered here: the worker script itself (scripts/worker.ts) against a real database and chain. Its start-up check
// is loadWorkerConfig, tested below; the loop it runs is campaignWorker.test.ts, and the rehearsal runs it on a fork.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GRAPH_G1, parseAddress } from '@thuli/core';
import { loadWorkerConfig, readFactoryRecord, scrubber, secretsOf, WorkerConfigError } from '../src/campaign/config.ts';

const KEY = `0x${'5a'.repeat(32)}`;
const GOOD = {
  DATABASE_URL: 'postgres://thuli:hunter2-long-secret@db.example.com:5432/thuli',
  WORKER_PRIVATE_KEY: KEY,
  SERV_API_KEY: 'sk-serv-not-a-real-key',
  SERV_BASE_URL: 'https://inference-api.openserv.ai/v1/',
  SERV_GRAPH_ID: GRAPH_G1.graphId,
  ETH_RPC_URL: 'https://eth.example.com/v1/rpc-key-123456',
  BLOCKSCOUT_ETH_API: 'https://eth.blockscout.com/api/v2',
  BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
};
const NAMES = Object.keys(GOOD);

describe('loadWorkerConfig', () => {
  it('names every missing variable on its own line', () => {
    let message = '';
    try {
      loadWorkerConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigError);
      message = (error as Error).message;
    }
    for (const name of NAMES) expect(message).toMatch(new RegExp(`^  ${name} is missing: it must be `, 'm'));
  });

  it('says which values are invalid without ever repeating one', () => {
    const bad = {
      ...GOOD,
      DATABASE_URL: 'mysql://root:hunter2-long-secret@db',
      WORKER_PRIVATE_KEY: `${KEY}ff`,
      SERV_BASE_URL: 'http://inference-api.openserv.ai/v1',
      SERV_GRAPH_ID: 'gr_unknown-graph',
      BASE_SEPOLIA_RPC_URL: 'http://sepolia.base.org',
    };
    let message = '';
    try {
      loadWorkerConfig(bad);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['DATABASE_URL', 'WORKER_PRIVATE_KEY', 'SERV_BASE_URL', 'SERV_GRAPH_ID', 'BASE_SEPOLIA_RPC_URL']) {
      expect(message).toContain(`${name} is not valid`);
    }
    for (const value of Object.values(bad)) expect(message).not.toContain(value);
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain(KEY.slice(2));
  });

  it('reads a good environment, trims base URLs and allows a local fork for the chain', () => {
    const config = loadWorkerConfig({ ...GOOD, BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:8546' });
    expect(config).toMatchObject({ servBaseUrl: 'https://inference-api.openserv.ai/v1', chainRpcUrl: 'http://127.0.0.1:8546' });
  });
});

describe('loadWorkerConfig without campaign settings', () => {
  it('loads an environment that holds only the names the worker reads, with no campaign id or vault block', () => {
    const only = {
      DATABASE_URL: GOOD.DATABASE_URL,
      WORKER_PRIVATE_KEY: GOOD.WORKER_PRIVATE_KEY,
      SERV_API_KEY: GOOD.SERV_API_KEY,
      SERV_BASE_URL: GOOD.SERV_BASE_URL,
      SERV_GRAPH_ID: GOOD.SERV_GRAPH_ID,
      ETH_RPC_URL: GOOD.ETH_RPC_URL,
      BLOCKSCOUT_ETH_API: GOOD.BLOCKSCOUT_ETH_API,
      BASE_SEPOLIA_RPC_URL: GOOD.BASE_SEPOLIA_RPC_URL,
    };
    const config = loadWorkerConfig(only);
    expect(Object.keys(config).sort()).toEqual(
      ['blockscoutApi', 'chainRpcUrl', 'databaseUrl', 'ethRpcUrl', 'reppo', 'servApiKey', 'servBaseUrl', 'servGraphId', 'workerKey'].sort(),
    );
    expect(config.reppo).toBeNull();
  });
});

describe('loadWorkerConfig and the outside check', () => {
  const REPPO_KEY = 'reppo-key-not-real-0123456789';
  const REPPO_URL = 'https://eval.reppo.xyz/api/v1';

  it('reads the Reppo key and base URL when the key is set, and leaves the appeal step off without it', () => {
    expect(loadWorkerConfig({ ...GOOD, REPPO_BASE_URL: REPPO_URL }).reppo).toBeNull();
    expect(loadWorkerConfig({ ...GOOD, REPPO_API_KEY: '  ', REPPO_BASE_URL: REPPO_URL }).reppo).toBeNull();
    expect(loadWorkerConfig({ ...GOOD, REPPO_API_KEY: REPPO_KEY, REPPO_BASE_URL: `${REPPO_URL}/` }).reppo).toEqual({ apiKey: REPPO_KEY, baseUrl: REPPO_URL });
  });

  it('refuses a Reppo key with no https base URL, naming the variable and never the key', () => {
    for (const [base, words] of [
      [undefined, 'REPPO_BASE_URL is missing'],
      ['http://eval.reppo.xyz/api/v1', 'REPPO_BASE_URL is not valid'],
    ] as const) {
      let message = '';
      try {
        loadWorkerConfig({ ...GOOD, REPPO_API_KEY: REPPO_KEY, ...(base === undefined ? {} : { REPPO_BASE_URL: base }) });
      } catch (error) {
        expect(error).toBeInstanceOf(WorkerConfigError);
        message = (error as Error).message;
      }
      expect(message).toContain(words);
      expect(message).not.toContain(REPPO_KEY);
    }
  });

  it('blanks the Reppo key from every log line', () => {
    const clean = scrubber(secretsOf(loadWorkerConfig({ ...GOOD, REPPO_API_KEY: REPPO_KEY, REPPO_BASE_URL: REPPO_URL })));
    expect(clean(`appeal failed: Bearer ${REPPO_KEY}`)).toBe('appeal failed: Bearer [hidden]');
  });
});

describe('scrubber', () => {
  it('blanks the key in either case and without 0x, the SERV key, the database password and the RPC URLs', () => {
    const config = loadWorkerConfig(GOOD);
    const clean = scrubber(secretsOf(config));
    const line = `failed: ${KEY.toUpperCase().replace('0X', '0x')} ${KEY.slice(2)} ${GOOD.SERV_API_KEY} hunter2-long-secret ${GOOD.ETH_RPC_URL}`;
    const cleaned = clean(line);
    expect(cleaned).not.toMatch(/5a5a5a5a/i);
    expect(cleaned).not.toContain('sk-serv');
    expect(cleaned).not.toContain('hunter2');
    expect(cleaned).not.toContain('rpc-key-123456');
    expect(clean('publish demo: list version 1 posted')).toBe('publish demo: list version 1 posted');
  });
});

describe('readFactoryRecord', () => {
  it('reads the factory and its deploy block from the committed Base Sepolia deployment record', () => {
    const file = fileURLToPath(new URL('../../contracts/deployments/base-sepolia.json', import.meta.url));
    const record = readFactoryRecord(file);
    expect(record.address).toBe(parseAddress(record.address));
    expect(record.block).toBeGreaterThan(0n);
    expect(() => readFactoryRecord(fileURLToPath(new URL('./missing.json', import.meta.url)))).toThrow(WorkerConfigError);
  });
});
