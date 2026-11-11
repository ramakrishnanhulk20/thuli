// Covers the record loader and its checks, the USDC text, the shorteners and the strings the section prints, against
// the real record. It does not cover drawing, the scroll-in line, the layout or any link in a browser; those need a
// built page.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA } from '../lib/contracts';
import { VERIFIED_SOURCE_BASE } from '../lib/explorer';
import { formatInt } from '../lib/format';
import {
  checkVaultProof,
  delayText,
  describeVaultProof,
  formatUsdc6,
  loadVaultProof,
  PROOF_STEP_LABELS,
  shortAddress,
  shortHash,
  VaultProofError,
  type VaultProofRecord,
} from '../lib/vaultProof';

const file = path.join(import.meta.dirname, '..', '..', 'contracts', 'deployments', 'base-sepolia-proof.json');
const original = JSON.parse(fs.readFileSync(file, 'utf8')) as VaultProofRecord;
const ELLIPSIS = String.fromCharCode(8230);

// A fresh deep copy each time, so one case can never leak a change into the next.
function copy(change: (record: Record<string, any>) => void): unknown {
  const record = JSON.parse(JSON.stringify(original)) as Record<string, any>;
  change(record);
  return record;
}

describe('loadVaultProof', () => {
  it('returns the values the record holds', () => {
    const record = loadVaultProof(file);
    expect(record).toEqual(original);
    expect(record.vault).toBe(original.vault);
    expect(record.transactions.map((entry) => entry.hash)).toEqual(original.transactions.map((entry) => entry.hash));
    expect(record.paid).toEqual(original.paid);
    expect(record.refused).toEqual(original.refused);
  });

  it('fails with a clear message when the file is missing or not JSON', () => {
    expect(() => loadVaultProof(path.join(import.meta.dirname, 'no-such-record.json'))).toThrow(VaultProofError);
    expect(() => loadVaultProof(path.join(import.meta.dirname, 'vaultProof.test.ts'))).toThrow(/not valid JSON/);
  });
});

describe('checkVaultProof', () => {
  it('accepts the real record, and a factory written in another case', () => {
    expect(() => checkVaultProof(original)).not.toThrow();
    expect(() => checkVaultProof(copy((r) => (r.factory = BASE_SEPOLIA.factory.toUpperCase().replace('0X', '0x'))))).not.toThrow();
  });

  it('throws when the schema is not 1', () => {
    expect(() => checkVaultProof(copy((r) => (r.schema = 2)))).toThrow(/schema/);
  });

  it('throws when the chain id is not 84532', () => {
    expect(() => checkVaultProof(copy((r) => (r.chainId = 8453)))).toThrow(/chainId/);
  });

  it('throws when the factory is not the one in lib/contracts.ts', () => {
    expect(() => checkVaultProof(copy((r) => (r.factory = `0x${'1'.repeat(40)}`)))).toThrow(/factory/);
  });

  it('throws when a transaction hash is not 0x and 64 lowercase hex characters', () => {
    const hash = original.transactions[0]?.hash as string;
    expect(() => checkVaultProof(copy((r) => (r.transactions[0].hash = hash.toUpperCase().replace('0X', '0x'))))).toThrow(/hash/);
    expect(() => checkVaultProof(copy((r) => (r.transactions[2].hash = hash.slice(0, -1))))).toThrow(/hash/);
    expect(() => checkVaultProof(copy((r) => (r.transactions[4].hash = hash.slice(2))))).toThrow(/hash/);
  });

  it('throws when the five labels are not present once each', () => {
    expect(() => checkVaultProof(copy((r) => (r.transactions[1].label = 'createVault')))).toThrow(/more than once/);
    expect(() => checkVaultProof(copy((r) => (r.transactions[3].label = 'withdraw')))).toThrow(/not one of the five/);
    expect(() => checkVaultProof(copy((r) => r.transactions.pop()))).toThrow(/exactly 5/);
    expect(() => checkVaultProof(copy((r) => r.transactions.push({ ...r.transactions[0] })))).toThrow(/exactly 5/);
  });

  it('throws when the explorer is not exactly https://sepolia.basescan.org', () => {
    expect(() => checkVaultProof(copy((r) => (r.explorer = 'https://sepolia.basescan.org/')))).toThrow(/explorer/);
    expect(() => checkVaultProof(copy((r) => (r.explorer = VERIFIED_SOURCE_BASE)))).toThrow(/explorer/);
    expect(() => checkVaultProof(copy((r) => delete r.explorer))).toThrow(/explorer/);
  });

  it('throws when a value the page shows is malformed', () => {
    expect(() => checkVaultProof(copy((r) => (r.vault = '0x12')))).toThrow(/vault/);
    expect(() => checkVaultProof(copy((r) => (r.paid.amount = '1.5')))).toThrow(/amount/);
    expect(() => checkVaultProof(copy((r) => (r.deposited = '')))).toThrow(/deposited/);
    expect(() => checkVaultProof(copy((r) => (r.rootDelaySeconds = 0)))).toThrow(/rootDelaySeconds/);
    expect(() => checkVaultProof(copy((r) => (r.refused.error = '<script>')))).toThrow(/error/);
    expect(() => checkVaultProof(copy((r) => (r.transactions[0].gasUsed = -1)))).toThrow(/gasUsed/);
    expect(() => checkVaultProof(null)).toThrow(VaultProofError);
    expect(() => checkVaultProof([])).toThrow(VaultProofError);
  });
});

describe('formatUsdc6', () => {
  it('writes whole units, fractions and a single base unit', () => {
    expect(formatUsdc6('1000000')).toBe('1');
    expect(formatUsdc6('2500000')).toBe('2.5');
    expect(formatUsdc6('1')).toBe('0.000001');
    expect(formatUsdc6('0')).toBe('0');
    expect(formatUsdc6('2000000')).toBe('2');
    expect(formatUsdc6('1234567')).toBe('1.234567');
    expect(formatUsdc6('0001000000')).toBe('1');
  });

  it('does not lose digits above the size of a double', () => {
    expect(formatUsdc6('123456789012345678901234567890')).toBe('123456789012345678901234.56789');
  });

  it('throws on text that is not whole digits', () => {
    for (const bad of ['', ' 1', '1 ', '1.5', '-1', '1e6', '0x10', 'abc', '1,000']) {
      expect(() => formatUsdc6(bad)).toThrow(RangeError);
    }
  });
});

describe('shorteners and the delay', () => {
  it('keeps 6 and 4 characters of an address and 10 and 6 of a hash', () => {
    const account = original.paid.account;
    expect(shortAddress(account)).toBe(`${account.slice(0, 6)}${ELLIPSIS}${account.slice(-4)}`);
    const hash = original.transactions[0]?.hash as string;
    expect(shortHash(hash)).toBe(`${hash.slice(0, 10)}${ELLIPSIS}${hash.slice(-6)}`);
  });

  it('writes one hour in the singular and every other number in hours', () => {
    expect(delayText(3600)).toBe('1 hour');
    expect(delayText(7200)).toBe('2 hours');
    expect(delayText(86400)).toBe('24 hours');
    expect(delayText(5400)).toBe('1.5 hours');
  });
});

describe('describeVaultProof', () => {
  const view = describeVaultProof(original);

  it('builds the five steps in the record order, with names from the record', () => {
    expect(view.steps.map((step) => step.label)).toEqual(original.transactions.map((entry) => entry.label));
    expect(view.steps.map((step) => step.label)).toEqual([...PROOF_STEP_LABELS]);
    expect(view.steps.map((step) => step.name)).toEqual([
      'Vault created',
      'Spending approved',
      `${formatUsdc6(original.deposited)} USDC deposited`,
      'List posted',
      `${formatUsdc6(original.paid.amount)} USDC claimed`,
    ]);
  });

  it('links each hash to the explorer transaction page and shows its gas', () => {
    view.steps.forEach((step, index) => {
      const entry = original.transactions[index] as VaultProofRecord['transactions'][number];
      expect(step.href).toBe(`${original.explorer}/tx/${entry.hash}`);
      expect(step.shortHash).toBe(shortHash(entry.hash));
      expect(step.gas).toBe(`${formatInt(entry.gasUsed)} GAS`);
    });
  });

  it('builds the cards, the delay and the two links from the record', () => {
    expect(view.delay).toBe(delayText(original.rootDelaySeconds));
    expect(view.paid).toEqual({ short: shortAddress(original.paid.account), amount: formatUsdc6(original.paid.amount) });
    expect(view.refused).toEqual({ short: shortAddress(original.refused.account), error: original.refused.error });
    expect(view.vaultUrl).toBe(`${original.explorer}/address/${original.vault.toLowerCase()}`);
    expect(view.factoryUrl).toBe(`${VERIFIED_SOURCE_BASE}/address/${BASE_SEPOLIA.factory}`);
  });
});
