// Not covered here: the free /api/check route that reads and writes this cache, so "all spellings of one address cost
// one model run between them" (C24) is shown only at the cache's door: they all reach one row. Body size is not capped
// by this package, and parseAddress itself is tested in packages/core.
import { AddressError } from '@thuli/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readCheck, writeCheck } from '../src/checkCache.ts';
import { openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

const CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const LOWER = CHECKSUMMED.toLowerCase();
const UPPER = `0x${CHECKSUMMED.slice(2).toUpperCase()}`;
const WRONG_CHECKSUM = '0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const BODY = { decision: 'hold', causes: ['shared funder'], facts: { hops: 2, ratio: 0.25 } };

function plus(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

describe('check cache', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openMemoryDb();
    await migrate(db);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE check_cache');
  });
  afterAll(async () => {
    await db.close();
  });

  it('C1: a write in lowercase and a read in checksummed form hit the same row, stored in the canonical form', async () => {
    await writeCheck(db, { address: LOWER, chain: 8453, rulebook: 2 }, BODY, NOW, 600);
    expect(await readCheck(db, { address: CHECKSUMMED, chain: 8453, rulebook: 2 }, NOW)).toEqual(BODY);
    expect(await readCheck(db, { address: UPPER, chain: 8453, rulebook: 2 }, NOW)).toEqual(BODY);
    expect(await readCheck(db, { address: `\ufeff ${LOWER}\r\n`, chain: 8453, rulebook: 2 }, NOW)).toEqual(BODY);
    await writeCheck(db, { address: UPPER, chain: 8453, rulebook: 2 }, { decision: 'approve' }, NOW, 600);
    expect(await db.query('SELECT address FROM check_cache')).toEqual([{ address: CHECKSUMMED }]);
    expect(await readCheck(db, { address: LOWER, chain: 8453, rulebook: 2 }, NOW)).toEqual({ decision: 'approve' });
  });

  it('C1: a mixed-case address with a wrong checksum is refused on write and on read, and nothing is written', async () => {
    await expect(writeCheck(db, { address: WRONG_CHECKSUM, chain: 8453, rulebook: 2 }, BODY, NOW, 600)).rejects.toThrow(
      AddressError,
    );
    await expect(readCheck(db, { address: WRONG_CHECKSUM, chain: 8453, rulebook: 2 }, NOW)).rejects.toThrow(AddressError);
    await expect(readCheck(db, { address: '0x1234', chain: 8453, rulebook: 2 }, NOW)).rejects.toThrow(AddressError);
    expect(await db.query('SELECT address FROM check_cache')).toEqual([]);
  });

  it('returns the body only while expires_at is after now', async () => {
    await writeCheck(db, { address: CHECKSUMMED, chain: 8453, rulebook: 2 }, BODY, NOW, 600);
    expect(await readCheck(db, { address: CHECKSUMMED, chain: 8453, rulebook: 2 }, plus(599.999))).toEqual(BODY);
    expect(await readCheck(db, { address: CHECKSUMMED, chain: 8453, rulebook: 2 }, plus(600))).toBeNull();
  });

  it('keys each chain and rulebook apart', async () => {
    await writeCheck(db, { address: CHECKSUMMED, chain: 8453, rulebook: 1 }, { rulebook: 1 }, NOW, 600);
    await writeCheck(db, { address: CHECKSUMMED, chain: 8453, rulebook: 2 }, { rulebook: 2 }, NOW, 600);
    expect(await readCheck(db, { address: CHECKSUMMED, chain: 8453, rulebook: 1 }, NOW)).toEqual({ rulebook: 1 });
    expect(await readCheck(db, { address: CHECKSUMMED, chain: 8453, rulebook: 2 }, NOW)).toEqual({ rulebook: 2 });
    expect(await readCheck(db, { address: CHECKSUMMED, chain: 1, rulebook: 2 }, NOW)).toBeNull();
  });

  it('refuses a null body, a body JSON cannot hold, and a chain, rulebook or lifetime out of range', async () => {
    const key = { address: CHECKSUMMED, chain: 8453, rulebook: 2 };
    await expect(writeCheck(db, key, null, NOW, 600)).rejects.toThrow(StoreError);
    await expect(writeCheck(db, key, undefined, NOW, 600)).rejects.toThrow(StoreError);
    await expect(writeCheck(db, key, { big: 1n }, NOW, 600)).rejects.toThrow(StoreError);
    await expect(writeCheck(db, key, BODY, NOW, 0)).rejects.toThrow(StoreError);
    await expect(writeCheck(db, { ...key, chain: 0 }, BODY, NOW, 600)).rejects.toThrow(StoreError);
    await expect(writeCheck(db, { ...key, rulebook: 2.5 }, BODY, NOW, 600)).rejects.toThrow(StoreError);
    await expect(readCheck(db, key, new Date(Number.NaN))).rejects.toThrow(StoreError);
    expect(await db.query('SELECT address FROM check_cache')).toEqual([]);
  });
});
