// Not covered here: the source scan below reads text, it does not parse TypeScript. It checks every .query, .script
// and .exec call in packages/store/src and the SQL-looking string literals around them; a query text built in some
// other shape, such as an array joined into SQL, would need a new rule here. Set STORE_TEST_URL to a throwaway Postgres
// database to run the stored-and-read-back tests there too, which empties every Thuli table in it; without it, that run
// is skipped.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectPostgres, openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { countRecent, recordIfUnder } from '../src/limits.ts';
import { migrate } from '../src/migrate.ts';
import { claimPayment } from '../src/paymentClaims.ts';

const REAL_URL = process.env.STORE_TEST_URL;
const TARGETS = [
  { name: 'in-memory PGlite', open: openMemoryDb },
  {
    name: 'Postgres at STORE_TEST_URL',
    open: REAL_URL === undefined || REAL_URL === '' ? undefined : async () => connectPostgres(REAL_URL, { max: 10 }),
  },
];

const SOURCE = fileURLToPath(new URL('../src/', import.meta.url));
const TABLES = ['schema_migrations', 'payment_claims', 'leases', 'rate_events', 'day_counts', 'check_cache'];
const UNICODE_RUN = ['a', 'é', 'ß', 'Ж', '漢', '🙂', 'ש', 'ا', '́', '€'].join('').repeat(15);
const FIXTURES = ["'; drop table payment_claims; --", '%00', UNICODE_RUN, '$1'];
const NOW_SECONDS = 1_800_000_000n;
const NOW = new Date(Number(NOW_SECONDS) * 1000);

for (const { name, open } of TARGETS) {
  describe.skipIf(open === undefined)(`C43 fixtures on ${name}`, () => {
    let db: Db;
    beforeAll(async () => {
      db = await (open ?? openMemoryDb)();
      await migrate(db);
    });
    beforeEach(async () => {
      await db.query('TRUNCATE payment_claims, leases, rate_events, day_counts, check_cache');
    });
    afterAll(async () => {
      await db.close();
    });

    it('C43: hostile strings are stored as key, client and bucket where the lengths allow, and read back unchanged', async () => {
      expect([...UNICODE_RUN]).toHaveLength(150);
      const timing = { nowSeconds: NOW_SECONDS, latestSeconds: 330n };
      for (const fixture of FIXTURES) {
        expect(await claimPayment(db, fixture, NOW_SECONDS + 60n, 'owner', timing)).toBe('taken');
        expect(await claimPayment(db, fixture, NOW_SECONDS + 60n, 'other', timing)).toBe('in-use');
      }
      const keys = await db.query<{ key: string }>('SELECT key FROM payment_claims');
      expect(keys.map((row) => row.key).sort()).toEqual([...FIXTURES].sort());

      const clientFits = FIXTURES.filter((fixture) => [...fixture].length <= 64);
      const bucketFits = FIXTURES.filter((fixture) => [...fixture].length <= 40);
      expect(clientFits).toHaveLength(3);
      expect(bucketFits).toHaveLength(3);
      for (const fixture of clientFits) expect(await recordIfUnder(db, 'bucket', fixture, 5, 60, NOW)).toBe(true);
      for (const fixture of bucketFits) expect(await recordIfUnder(db, fixture, 'client', 5, 60, NOW)).toBe(true);
      await expect(recordIfUnder(db, 'bucket', UNICODE_RUN, 5, 60, NOW)).rejects.toThrow(StoreError);
      await expect(recordIfUnder(db, UNICODE_RUN, 'client', 5, 60, NOW)).rejects.toThrow(StoreError);
      for (const fixture of clientFits) expect(await countRecent(db, 'bucket', fixture, 60, NOW)).toBe(1);
      for (const fixture of bucketFits) expect(await countRecent(db, fixture, 'client', 60, NOW)).toBe(1);
      const clients = await db.query<{ client: string }>("SELECT client FROM rate_events WHERE bucket = 'bucket'");
      expect(clients.map((row) => row.client).sort()).toEqual([...clientFits].sort());
      const buckets = await db.query<{ bucket: string }>("SELECT bucket FROM rate_events WHERE client = 'client'");
      expect(buckets.map((row) => row.bucket).sort()).toEqual([...bucketFits].sort());

      for (const table of TABLES) {
        const [row] = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
        expect({ table, present: row?.present }).toEqual({ table, present: true });
      }
    });

    it('C43: a lone surrogate, which a driver would silently rewrite, is refused rather than stored changed', async () => {
      const timing = { nowSeconds: NOW_SECONDS, latestSeconds: 330n };
      await expect(claimPayment(db, 'key-\uD800', NOW_SECONDS + 60n, 'owner', timing)).rejects.toThrow(StoreError);
      expect(await db.query('SELECT key FROM payment_claims')).toEqual([]);
    });
  });
}

// What the scan flags: a query whose text is not one plain literal, a literal with a ${} placeholder, or a literal
// joined to anything with +. The pass-through sites are named here by file, each forwarding text whose own call site
// is checked by this same scan or, in migrate.ts, the contents of a migration file.
const PASS_THROUGH: Record<string, string[]> = {
  'db.ts': ['text', 'config'],
  'migrate.ts': ['file.sql'],
};
const SQL_WORD = /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|FROM|DROP|CREATE)\b/;

function closingQuote(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === quote) return index;
  }
  return -1;
}

function scan(file: string, source: string): { sites: number; problems: string[] } {
  const problems: string[] = [];
  let sites = 0;
  for (const match of source.matchAll(/\.(query|script|exec)\b/g)) {
    let index = (match.index ?? 0) + match[0].length;
    if (source[index] === '<') {
      let depth = 0;
      for (; index < source.length; index += 1) {
        if (source[index] === '<') depth += 1;
        if (source[index] === '>' && source[index - 1] !== '=') depth -= 1;
        if (depth === 0) break;
      }
      index += 1;
    }
    if (source[index] !== '(') continue;
    sites += 1;
    index += 1;
    while (/\s/.test(source[index] ?? '')) index += 1;
    const where = `${file}:${source.slice(0, index).split('\n').length}`;
    const first = source[index] ?? '';
    let end: number;
    if (first === "'" || first === '"' || first === '`') {
      end = closingQuote(source, index, first);
      if (end === -1) {
        problems.push(`${where} unterminated query text`);
        continue;
      }
      if (first === '`' && source.slice(index, end).includes('${')) problems.push(`${where} placeholder in query text`);
      end += 1;
    } else {
      const name = /^[A-Za-z_$][\w$.]*/.exec(source.slice(index))?.[0] ?? '';
      if (!(PASS_THROUGH[file] ?? []).includes(name)) problems.push(`${where} query text is not a literal: ${name}`);
      end = index + name.length;
    }
    while (/\s/.test(source[end] ?? '')) end += 1;
    if (source[end] !== ',' && source[end] !== ')') problems.push(`${where} query text is joined to something`);
  }
  for (const template of source.matchAll(/`[^`]*`/g)) {
    if (SQL_WORD.test(template[0]) && template[0].includes('${')) problems.push(`${file} SQL template with a placeholder`);
  }
  for (const joined of source.matchAll(/(['"`])(?:(?!\1)[^\\\n]|\\.)*\1\s*\+|\+\s*(['"`])(?:(?!\2)[^\\\n]|\\.)*\2/g)) {
    if (SQL_WORD.test(joined[0])) problems.push(`${file} SQL text joined with +`);
  }
  return { sites, problems };
}

describe('C43 source scan', () => {
  it('catches the shapes it is meant to catch', () => {
    expect(scan('x.ts', "await db.query(`SELECT body FROM t WHERE k = '${key}'`);").problems).not.toEqual([]);
    expect(scan('x.ts', "await db.query('SELECT body FROM t WHERE k = ' + key);").problems).not.toEqual([]);
    expect(scan('x.ts', 'await db.query(sql, [key]);').problems).not.toEqual([]);
    expect(scan('x.ts', "const sql = 'DELETE FROM t WHERE k = ' + key;").problems).not.toEqual([]);
    expect(scan('x.ts', "await tx.query<{ n: number }>('SELECT n FROM t WHERE k = $1', [key]);")).toEqual({
      sites: 1,
      problems: [],
    });
  });

  it('C43: every query text in packages/store/src is one literal, and values travel only as parameters', async () => {
    const files = (await readdir(SOURCE)).filter((file) => file.endsWith('.ts'));
    expect(files.sort()).toEqual(['campaigns.ts', 'checkCache.ts', 'db.ts', 'index.ts', 'limits.ts', 'migrate.ts', 'paymentClaims.ts', 'sweep.ts']);
    let sites = 0;
    const problems: string[] = [];
    for (const file of files) {
      const result = scan(file, await readFile(path.join(SOURCE, file), 'utf8'));
      sites += result.sites;
      problems.push(...result.problems);
    }
    expect(problems).toEqual([]);
    expect(sites).toBeGreaterThanOrEqual(30);
  });
});
