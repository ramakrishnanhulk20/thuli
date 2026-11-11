import { parseAddress } from '@thuli/core';
import { instant, shifted, StoreError, wholeNumber, type Db } from './db.ts';

/** One cached result of the free wallet check: a wallet, on one chain, judged by one rulebook version. */
export interface CheckKey {
  address: string;
  chain: number;
  rulebook: number;
}

const MAX_INTEGER = 2_147_483_647;

// Every spelling of one wallet becomes the one canonical form here, before it is stored or looked up (C1), so all
// spellings share one row and one model run between them (C24).
function canonicalKey(key: CheckKey): [string, number, number] {
  return [
    parseAddress(key.address),
    wholeNumber(key.chain, 'chain', 1, MAX_INTEGER),
    wholeNumber(key.rulebook, 'rulebook', 1, MAX_INTEGER),
  ];
}

/**
 * The cached body for key, while its expires_at is still after now.
 * @returns the body as written, or null when there is none or it has expired.
 * @throws AddressError from @thuli/core when the address is not a 0x address, or is mixed case with a wrong checksum.
 *   StoreError when chain or rulebook is not a whole number from 1, or now is not a valid Date.
 */
export async function readCheck(db: Db, key: CheckKey, now: Date): Promise<unknown | null> {
  const [address, chain, rulebook] = canonicalKey(key);
  const [row] = await db.query<{ body: unknown }>(
    'SELECT body FROM check_cache WHERE address = $1 AND chain = $2 AND rulebook = $3 AND expires_at > $4::timestamptz',
    [address, chain, rulebook, instant(now)],
  );
  return row === undefined ? null : row.body;
}

/**
 * Stores body for key, checked at now and kept until now plus ttlSeconds, replacing any earlier body for that key.
 * @param body any JSON value except null, which would read back the same as no result.
 * @throws AddressError as readCheck. StoreError when chain, rulebook or ttlSeconds is not a whole number from 1, now
 *   is not a valid Date, or body is null or cannot be written as JSON.
 */
export async function writeCheck(db: Db, key: CheckKey, body: unknown, now: Date, ttlSeconds: number): Promise<void> {
  const [address, chain, rulebook] = canonicalKey(key);
  wholeNumber(ttlSeconds, 'ttlSeconds', 1, MAX_INTEGER);
  let json: string | undefined;
  try {
    json = JSON.stringify(body);
  } catch {
    throw new StoreError('the check body cannot be written as JSON');
  }
  if (json === undefined || body === null) throw new StoreError('the check body must be a JSON value other than null');
  await db.query(
    `INSERT INTO check_cache (address, chain, rulebook, body, checked_at, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
     ON CONFLICT (address, chain, rulebook)
     DO UPDATE SET body = excluded.body, checked_at = excluded.checked_at, expires_at = excluded.expires_at`,
    [address, chain, rulebook, json, instant(now), shifted(now, ttlSeconds)],
  );
}
