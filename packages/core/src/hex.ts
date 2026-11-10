// Every check of model text for hashes goes through reasonHashes, so a hash in a reason is never judged by two different
// parsers on the two answer routes (C13, standard C.2).

// No left boundary on purpose: "tx0x..." or "(0x..." still names a hash, and a word boundary hid exactly those.
const PREFIXED_RUN = /0[xX][0-9a-fA-F]+/g;
const BARE_RUN = /(?<![0-9a-fA-F])[0-9a-fA-F]{16,}(?![0-9a-fA-F])/g;
const FULL_HASH = /^0[xX][0-9a-fA-F]{64}$/;
const HEX_LETTER = /[a-fA-F]/;

/** The one cause for anything in a reason that looks like a hash but is not a full transaction hash. */
export const MALFORMED_HASH_CAUSE = 'the reason contains a malformed transaction hash';

/**
 * The transaction hashes a text names, lowercase and once each, or ok false when it holds anything else that reads as
 * one. Every 0x run counts wherever it sits, even inside a word, and only 0x with exactly 64 hex digits is a hash; an
 * address, a shortened hash or one too long is malformed. A bare run of 16 or more hex digits with a letter among them is
 * a hash written without its 0x, and is malformed too. A bare run of digits only is a number, such as an amount in wei.
 *
 * The 0x runs are taken out before the bare scan, so digits written right before a 0x cannot swallow its 0 and turn the
 * run after it into an all-digit bare run that passes. Not covered: hex in look-alike characters, which plain text
 * checks do not catch either, so reasons are shown inert (C33).
 */
export function reasonHashes(text: string): { ok: true; hashes: string[] } | { ok: false } {
  const hashes = new Set<string>();
  for (const [run] of text.matchAll(PREFIXED_RUN)) {
    if (!FULL_HASH.test(run)) return { ok: false };
    hashes.add(`0x${run.slice(2).toLowerCase()}`);
  }
  const rest = text.replace(PREFIXED_RUN, ' ');
  for (const [run] of rest.matchAll(BARE_RUN)) {
    if (HEX_LETTER.test(run)) return { ok: false };
  }
  return { ok: true, hashes: [...hashes] };
}
