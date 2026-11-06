import fs from 'node:fs';
import { z } from 'zod';
import { AppealError, AppealRecord, parseAddress } from '@thuli/core';
import { JsonlCache } from '../chain/jsonlCache.ts';

// A full appeal is about 3 KB a line, so this holds some 20,000 lines, far past any one file we expect (C41).
const MAX_STORE_BYTES = 64 * 1024 * 1024;

const KeyedLine = z.object({ key: z.string() });

export type Filing = { stored: true } | { stored: false; cause: string };

const keyOf = (campaignId: string, wallet: string) => `${campaignId}:${wallet}`;

// Compares what the wallet signed, not the signature text, because one message has more than one valid signature.
const sameSignedAppeal = (a: AppealRecord, b: AppealRecord) => a.textHash === b.textHash && a.signedAt === b.signedAt;

/**
 * The appeals, one JSON line each, keyed by campaign and wallet. Lines are only ever added, so the file keeps every step
 * of an appeal, and the later line for a key is what reads back.
 *
 * Not safe for two processes writing one file at once (see JsonlCache). The rate limit half of C42 belongs to the public
 * endpoint, which does not exist yet.
 */
export class AppealStore {
  readonly #filePath: string;
  readonly #cache: JsonlCache<AppealRecord>;

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#cache = new JsonlCache(filePath, AppealRecord);
  }

  /** @throws AddressError when the wallet is not an address. Every spelling of a wallet finds the same appeal (C1). */
  get(campaignId: string, wallet: string): AppealRecord | undefined {
    return this.#cache.get(keyOf(campaignId, parseAddress(wallet)));
  }

  /**
   * Stores a new open appeal. A wallet has one open appeal per campaign (C42). The same signed appeal sent again is never
   * stored twice, and it cannot reopen one the owner settled, even inside its signature window. After a settlement, an
   * appeal the wallet signs afresh may open a new round; the settled line stays in the file.
   *
   * @returns stored true, or stored false with a fixed cause. Nothing is written when refused.
   * @throws AppealError when the record is not open.
   * @throws ZodError when the record does not match AppealRecord; nothing is written.
   */
  openAppeal(record: AppealRecord): Filing {
    if (record.status !== 'open') throw new AppealError('only an open appeal can be filed');
    const key = keyOf(record.campaignId, record.wallet);
    const existing = this.#cache.get(key);
    if (existing !== undefined) {
      if (sameSignedAppeal(existing, record)) return { stored: false, cause: 'this appeal is already stored' };
      if (existing.status === 'open') return { stored: false, cause: 'an appeal is already open for this wallet in this campaign' };
    }
    this.#cache.put(key, record);
    return { stored: true };
  }

  /**
   * Replaces an open appeal with its settled record from settleAppeal. Checking against the stored line means a stale copy
   * of an open record cannot settle the same appeal a second time.
   *
   * @throws AppealError when the record is still open, or no matching open appeal is stored.
   * @throws ZodError when the record does not match AppealRecord; nothing is written.
   */
  saveSettled(record: AppealRecord): void {
    if (record.status === 'open') throw new AppealError('this appeal has not been settled');
    const key = keyOf(record.campaignId, record.wallet);
    const existing = this.#cache.get(key);
    if (existing === undefined || existing.status !== 'open' || !sameSignedAppeal(existing, record)) {
      throw new AppealError('no matching open appeal is stored');
    }
    this.#cache.put(key, record);
  }

  /**
   * Every appeal stored for one campaign, latest state only. JsonlCache cannot list its entries, so this reads the keys
   * from the file itself, then takes each record from the cache, so a line the schema refused is left out here too.
   *
   * @throws AppealError when the file is past the size cap (C41).
   */
  forCampaign(campaignId: string): AppealRecord[] {
    if (!fs.existsSync(this.#filePath)) return [];
    if (fs.statSync(this.#filePath).size > MAX_STORE_BYTES) throw new AppealError('the appeal file is too large to read');
    const prefix = `${campaignId}:`;
    const keys = new Set<string>();
    for (const line of fs.readFileSync(this.#filePath, 'utf8').split('\n')) {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = KeyedLine.safeParse(json);
      if (parsed.success && parsed.data.key.startsWith(prefix)) keys.add(parsed.data.key);
    }
    return [...keys].flatMap((key) => this.#cache.get(key) ?? []);
  }
}
