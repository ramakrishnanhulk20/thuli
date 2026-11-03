// Not covered here: two processes writing one file at once (a stated non-goal of JsonlCache), and a disk that fills
// up or a write that fails partway, beyond the truncated last line such a failure leaves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonlCache } from '../src/chain/jsonlCache.ts';

const Value = z.object({ n: z.int() });

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('JsonlCache', () => {
  it('keeps what was put across a reload from disk, the last write for a key winning', () => {
    const file = path.join(dir, 'not', 'yet', 'made', 'pages.jsonl');
    const cache = new JsonlCache(file, Value);
    cache.put('a', { n: 1 });
    cache.put('b', { n: 2 });
    cache.put('a', { n: 3 });
    expect(cache.size).toBe(2);

    const reloaded = new JsonlCache(file, Value);
    expect(reloaded.size).toBe(2);
    expect(reloaded.get('a')).toEqual({ n: 3 });
    expect(reloaded.get('b')).toEqual({ n: 2 });
    expect(reloaded.has('c')).toBe(false);
    expect(reloaded.get('c')).toBeUndefined();
  });

  it('skips a truncated last line and a line that fails the schema, and the next put survives a reload', () => {
    const file = path.join(dir, 'pages.jsonl');
    fs.writeFileSync(file, '{"key":"a","value":{"n":1}}\n{"key":"b","value":{"n":"two"}}\n{"key":"c","value":{"n":');
    const cache = new JsonlCache(file, Value);
    expect(cache.size).toBe(1);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(false);

    cache.put('d', { n: 4 });
    const reloaded = new JsonlCache(file, Value);
    expect(reloaded.size).toBe(2);
    expect(reloaded.get('a')).toEqual({ n: 1 });
    expect(reloaded.get('d')).toEqual({ n: 4 });
  });

  it('reads a file larger than one read chunk, with lines split across chunks', () => {
    const file = path.join(dir, 'large.jsonl');
    const count = 40_000;
    const lines = Array.from({ length: count }, (_, n) => JSON.stringify({ key: `wallet-${n}`, value: { n } }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024);

    const cache = new JsonlCache(file, Value);
    expect(cache.size).toBe(count);
    expect(cache.get('wallet-0')).toEqual({ n: 0 });
    expect(cache.get(`wallet-${count - 1}`)).toEqual({ n: count - 1 });
  });
});
