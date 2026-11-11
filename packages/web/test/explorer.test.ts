// Covers the explorer helpers (the links for each chain, any letter case in and one link out, a bad address or hash
// refused), the constants against the vault proof record, and a scan of the site's sources that fails if any file other
// than lib/explorer.ts names an explorer host. It does not open a link or check that an explorer is up.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addressLink,
  addressUrl,
  BASE_CHAIN,
  BASE_SEPOLIA_CHAIN,
  BASE_SEPOLIA_EXPLORER,
  ETHEREUM_CHAIN,
  explorerAddressUrl,
  explorerBase,
  explorerTxUrl,
  txLink,
  txUrl,
  verifiedSourceUrl,
  VERIFIED_SOURCE_BASE,
} from '../lib/explorer';

const web = path.join(import.meta.dirname, '..');
const proof = JSON.parse(fs.readFileSync(path.join(web, '..', 'contracts', 'deployments', 'base-sepolia-proof.json'), 'utf8')) as { explorer: string; factory: string };

const LOWER = '0xadb8ad5a8bc359ff17d81dbe41833bb6b26b2034';
const CHECKSUMMED = '0xAdb8aD5A8BC359fF17D81DBe41833bB6b26B2034';
const HASH = '0xda041583c1c4170d470e537c7d36f41fc1912b398758a3612d492960e45bd13c';

const upper = (value: string) => `0x${value.slice(2).toUpperCase()}`;

describe('the explorer for each chain', () => {
  it('uses the Basescan address the vault proof record names for Base Sepolia', () => {
    expect(BASE_SEPOLIA_EXPLORER).toBe(proof.explorer);
    expect(explorerBase(BASE_SEPOLIA_CHAIN)).toBe(proof.explorer);
  });

  it('has one base for each of Ethereum, Base Sepolia and Base, and none for a chain it does not know', () => {
    expect(explorerBase(ETHEREUM_CHAIN)).toBe('https://etherscan.io');
    expect(explorerBase(BASE_SEPOLIA_CHAIN)).toBe('https://sepolia.basescan.org');
    expect(explorerBase(BASE_CHAIN)).toBe('https://basescan.org');
    expect([ETHEREUM_CHAIN, BASE_SEPOLIA_CHAIN, BASE_CHAIN]).toEqual([1, 84532, 8453]);
    expect(explorerBase(5)).toBeNull();
    expect(explorerBase(0)).toBeNull();
  });

  it('keeps the verified source on its own page, apart from the explorers', () => {
    expect(VERIFIED_SOURCE_BASE).toBe('https://base-sepolia.blockscout.com');
    expect([ETHEREUM_CHAIN, BASE_SEPOLIA_CHAIN, BASE_CHAIN].map(explorerBase)).not.toContain(VERIFIED_SOURCE_BASE);
  });
});

describe('an address link', () => {
  it('is one normalised link whatever the letter case of the address', () => {
    const want = `${BASE_SEPOLIA_EXPLORER}/address/${LOWER}`;
    for (const given of [LOWER, CHECKSUMMED, upper(LOWER), `0X${LOWER.slice(2)}`]) {
      expect(explorerAddressUrl(BASE_SEPOLIA_CHAIN, given)).toBe(want);
      expect(addressLink(BASE_SEPOLIA_CHAIN, given)).toBe(want);
    }
  });

  it('follows the chain it is asked for', () => {
    expect(explorerAddressUrl(ETHEREUM_CHAIN, CHECKSUMMED)).toBe(`https://etherscan.io/address/${LOWER}`);
    expect(explorerAddressUrl(BASE_CHAIN, CHECKSUMMED)).toBe(`https://basescan.org/address/${LOWER}`);
  });

  it('is refused, never guessed, for anything that is not an address', () => {
    const bad = ['', '0x', `${LOWER}0`, LOWER.slice(0, -1), HASH, `${LOWER} `, ` ${LOWER}`, `${LOWER}\n`, LOWER.slice(2), '0xZZb8ad5a8bc359ff17d81dbe41833bb6b26b2034', '<script>alert(1)</script>'];
    for (const given of bad) {
      expect(() => explorerAddressUrl(BASE_SEPOLIA_CHAIN, given)).toThrow(RangeError);
      expect(addressLink(BASE_SEPOLIA_CHAIN, given)).toBeNull();
    }
    expect(() => explorerAddressUrl(BASE_SEPOLIA_CHAIN, undefined as never)).toThrow(RangeError);
    expect(addressLink(BASE_SEPOLIA_CHAIN, null as never)).toBeNull();
  });

  it('is refused for a chain with no explorer', () => {
    expect(() => explorerAddressUrl(5, LOWER)).toThrow(RangeError);
    expect(addressLink(5, LOWER)).toBeNull();
  });
});

describe('a transaction link', () => {
  it('is one normalised link whatever the letter case of the hash', () => {
    const want = `${BASE_SEPOLIA_EXPLORER}/tx/${HASH}`;
    for (const given of [HASH, upper(HASH), `0X${HASH.slice(2)}`, `0x${HASH.slice(2, 20).toUpperCase()}${HASH.slice(20)}`]) {
      expect(explorerTxUrl(BASE_SEPOLIA_CHAIN, given)).toBe(want);
      expect(txLink(BASE_SEPOLIA_CHAIN, given)).toBe(want);
    }
  });

  it('follows the chain it is asked for', () => {
    expect(explorerTxUrl(ETHEREUM_CHAIN, HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
    expect(explorerTxUrl(BASE_CHAIN, HASH)).toBe(`https://basescan.org/tx/${HASH}`);
  });

  it('is refused, never guessed, for anything that is not a hash', () => {
    const bad = ['', '0x', HASH.slice(0, -1), `${HASH}a`, LOWER, `${HASH} `, ` ${HASH}`, `${HASH}\n`, HASH.slice(2), `0x${'zz'.repeat(32)}`, '<script>alert(1)</script>'];
    for (const given of bad) {
      expect(() => explorerTxUrl(BASE_SEPOLIA_CHAIN, given)).toThrow(RangeError);
      expect(txLink(BASE_SEPOLIA_CHAIN, given)).toBeNull();
    }
    expect(() => explorerTxUrl(BASE_SEPOLIA_CHAIN, 42 as never)).toThrow(RangeError);
  });

  it('is refused for a chain with no explorer', () => {
    expect(() => explorerTxUrl(5, HASH)).toThrow(RangeError);
    expect(txLink(5, HASH)).toBeNull();
  });
});

describe('the verified source link', () => {
  it('is the verified-source page for the address, normalised', () => {
    expect(verifiedSourceUrl(CHECKSUMMED)).toBe(`${VERIFIED_SOURCE_BASE}/address/${LOWER}`);
    expect(verifiedSourceUrl(proof.factory)).toBe(`${VERIFIED_SOURCE_BASE}/address/${proof.factory.toLowerCase()}`);
  });

  it('is refused for anything that is not an address', () => {
    expect(() => verifiedSourceUrl('0x12')).toThrow(RangeError);
    expect(() => verifiedSourceUrl('')).toThrow(RangeError);
  });
});

describe('the Ethereum history links', () => {
  it('keep their strict, lowercase-only behaviour', () => {
    expect(txUrl(HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
    expect(addressUrl(LOWER)).toBe(`https://etherscan.io/address/${LOWER}`);
    expect(txUrl(upper(HASH))).toBeNull();
    expect(addressUrl(CHECKSUMMED)).toBeNull();
  });
});

describe('the site sources', () => {
  const HOST = /[\w.-]*(etherscan|basescan|blockscout)\.[a-z]{2,}/i;

  function sourcesUnder(folder: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) found.push(...sourcesUnder(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
    }
    return found;
  }

  it('read at least the folders the site is made of', () => {
    const files = ['components', 'app', 'lib'].flatMap((folder) => sourcesUnder(path.join(web, folder)));
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.endsWith(path.join('lib', 'explorer.ts')))).toBe(true);
  });

  it('name an explorer host in lib/explorer.ts and nowhere else', () => {
    const offenders = ['components', 'app', 'lib']
      .flatMap((folder) => sourcesUnder(path.join(web, folder)))
      .filter((file) => path.relative(web, file).split(path.sep).join('/') !== 'lib/explorer.ts')
      .filter((file) => HOST.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(web, file).split(path.sep).join('/'));
    expect(offenders).toEqual([]);
  });

  it('give lib/explorer.ts the hosts, so the scan is looking for the right thing', () => {
    expect(HOST.test(fs.readFileSync(path.join(web, 'lib', 'explorer.ts'), 'utf8'))).toBe(true);
  });
});
