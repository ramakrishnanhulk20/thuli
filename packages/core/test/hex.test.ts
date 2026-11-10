// Not covered here: what validateDecision and g1 do with the result (decision.test.ts and graphVersions.test.ts), and hex
// written in look-alike characters, which this scan does not read.
import { describe, expect, it } from 'vitest';
import { reasonHashes } from '../src/hex.ts';

const HASH = `0x${'ab'.repeat(32)}`;

describe('reasonHashes', () => {
  it('finds a hash wherever its 0x sits, in any case, and gives each once in lowercase', () => {
    const text = `Funded in tx${HASH.toUpperCase()}, swept in (${HASH}) and again ${HASH}s.`;
    expect(reasonHashes(text)).toEqual({ ok: true, hashes: [HASH] });
  });

  it.each([
    ['a short 0x run', 'Funded by 0x1a, an old wallet.'],
    ['a 0x run past 64 digits', `Swept in ${HASH}ab.`],
    ['a hash without its 0x', `Swept in ${'ab'.repeat(32)}.`],
    ['a bare run of 16 with one letter', 'Ref 123456789012345f here.'],
  ])('refuses %s', (_case, text) => {
    expect(reasonHashes(text)).toEqual({ ok: false });
  });

  it('leaves numbers and plain words alone', () => {
    expect(reasonHashes('Received 1234567890123456789 wei in 12 transactions, 10x the usual, from a faced deaf bead.')).toEqual({
      ok: true,
      hashes: [],
    });
  });
});
