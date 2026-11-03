// Not covered here: the live eth_getCode call itself, and fork fixtures for a real Safe or delegated EOA.
import { describe, expect, it } from 'vitest';
import { accountTypeFromCode } from '../src/accountType.ts';

describe('accountTypeFromCode (C20)', () => {
  it('maps empty code to eoa', () => {
    expect(accountTypeFromCode('0x')).toBe('eoa');
    expect(accountTypeFromCode(undefined)).toBe('eoa');
  });

  it('maps an EIP-7702 delegation designator to delegated_eoa, not contract', () => {
    const delegate = '63c0c19a282a1b52b07dd5a65b58948a07dae32b';
    expect(accountTypeFromCode(`0xef0100${delegate}`)).toBe('delegated_eoa');
  });

  it('maps any other code to contract', () => {
    expect(accountTypeFromCode('0x6080604052348015600f57600080fd5b50')).toBe('contract');
  });

  it('maps text that is not hex bytes to unknown', () => {
    expect(accountTypeFromCode('0xzz')).toBe('unknown');
    expect(accountTypeFromCode('0x123')).toBe('unknown');
  });
});
