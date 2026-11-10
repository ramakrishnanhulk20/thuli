// Every scan of model text for hashes uses these, so a hash in a reason is never judged by two different parsers (C13,
// standard C.2). A run long enough to be meant as a hash counts with or without its 0x, so a hash written without the
// prefix, an address or a shortened hash is refused rather than skipped by the citation check.
export const HEX_RUN = /\b(?:0[xX])?[0-9a-fA-F]{16,}\b/g;
export const FULL_HASH = /^0[xX][0-9a-fA-F]{64}$/;

/** The one cause for a hex run in a reason that is not a full transaction hash. */
export const MALFORMED_HASH_CAUSE = 'the reason contains a malformed transaction hash';
