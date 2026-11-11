// Covers the factory address and chain id the site shows against the deployment record. It does not check that the
// explorer link opens or that the contract is verified; the deploy script and the explorer cover those.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA } from '../lib/contracts';

const record = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'contracts', 'deployments', 'base-sepolia.json'), 'utf8'),
) as { chainId: number; factory: string };

describe('BASE_SEPOLIA', () => {
  it('shows the factory address the deployment record holds', () => {
    expect(BASE_SEPOLIA.factory.toLowerCase()).toBe(record.factory.toLowerCase());
  });

  it('uses the chain id the deployment record holds', () => {
    expect(BASE_SEPOLIA.chainId).toBe(record.chainId);
  });
});
