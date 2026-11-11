# Dependency audit

Checked on 11 Nov 2026, on a fresh `npm ci` of the repository followed by `npm audit`. The result was
`7 vulnerabilities (4 moderate, 3 high)`. Those seven lines come from two advisories. Neither can be fixed without
forcing a package across a major version its parent was not written for, so both are left as they are. This page
records why neither can reach a code path that runs in Thuli. Re-check at any time with `npm audit`.

The rule we follow: take a newer release of the package we declare when it brings a fixed copy; otherwise move only
the nested package, inside the major version its parent accepts; otherwise leave it and show, by tracing the calls,
whether our code can reach the vulnerable function at all.

## 1. uuid: missing buffer bounds check in v3, v5 and v6

| | |
| --- | --- |
| Advisory | GHSA-w5hq-g745-h8pq (npm 1119441), moderate |
| Affected | `uuid` below 11.1.1. We have `uuid` 9.0.1 |
| Audit lines it causes | `uuid`, `@metamask/utils`, `@metamask/abi-utils`, `@openzeppelin/merkle-tree` (all moderate) |
| How it enters | `@openzeppelin/merkle-tree` 1.0.8, which we declare in `packages/core`, needs `@metamask/abi-utils` ^2.0.4, which needs `@metamask/utils` ^9.0.0, which needs `uuid` ^9.0.1 |
| What we did | Left as is |

Why no upgrade: 1.0.8 is the newest `@openzeppelin/merkle-tree`. The fix is `uuid` 11.1.1, and no 9.x release fixes it.
Forcing `uuid` 11 under `@metamask/utils` 9, which asks for ^9, would cross a major version its parent does not accept.
A newer `@metamask/utils` (12) no longer uses `uuid` at all, but `@metamask/abi-utils` 2 accepts only ^9, so reaching it
crosses a major version too. npm's own suggestion, `@openzeppelin/merkle-tree` 1.0.7, is a downgrade; we keep the
version our vault proofs were built and checked with (threat model C28).

Why it cannot hurt Thuli:
- The advisory concerns `v3`, `v5` and `v6` called with a caller's own output buffer. Nothing in `@openzeppelin/merkle-tree`,
  `@metamask/abi-utils` or `@metamask/utils` calls `v3`, `v5` or `v6` (searched every installed file).
- `uuid` is loaded in only one module, `@metamask/utils/dist/fs` and its `.mjs` twin, which call `uuid.v4()` with no buffer
  inside `createSandbox`, a helper that makes a temporary test folder.
- That module is reachable only through the package's separate `@metamask/utils/node` entry. The main entry,
  `@metamask/utils`, does not load it, and `@metamask/abi-utils` imports only the main entry. Nothing in the installed
  tree loads `@metamask/utils/node`.
- Our only runtime import of the tree library is `StandardMerkleTree` in `packages/core/src/leaf.ts`.

Conclusion: the vulnerable functions are never called, and the module that loads `uuid` is never loaded, so no input of
ours, or anyone's, can reach this bug.

## 2. zod: memory exhaustion while validating oversized constrained collections

| | |
| --- | --- |
| Advisory | GHSA-mrhx-c7xc-m3w5 (npm 1243066), high |
| Affected | `zod` below 4.6.6. The copy nested inside `@coinbase/cdp-sdk` is 3.25.76; our own `zod` is 4.6.7, which is fixed |
| Audit lines it causes | `zod` (the nested copy), `abitype` (the copy nested inside the SDK, which uses that `zod`), `@coinbase/cdp-sdk` (all high) |
| How it enters | `@coinbase/cdp-sdk` 1.61.0, which we declare in `packages/api`, needs `zod` ^3.25.76 and `abitype` 1.0.6 |
| What we did | Left as is |

Why no upgrade: the newest `@coinbase/cdp-sdk`, 1.62.0, still asks for `zod` ^3.25.76. The fix is `zod` 4.6.6, so forcing it
under the SDK would move a package written for `zod` 3 onto `zod` 4, a real break in the code that signs and settles
payments, traded for a finding that does not reach us. npm's own suggestion, `@coinbase/cdp-sdk` 1.7.0, is a downgrade of
more than fifty releases.

Why it cannot hurt Thuli:
- Our code imports the SDK in one place: `createCdpFacilitatorClient` from `@coinbase/cdp-sdk/x402`, in
  `packages/api/src/config.ts`. It is created only when the paid route runs on Base mainnet.
- That function returns x402's own `HTTPFacilitatorClient` with signed CDP authorization headers. Every payment, request
  and reply on that path is parsed by x402, which uses our top-level `zod` 4.6.7, not the SDK's nested copy.
- In the whole SDK, the nested `zod` validates input in only one place: the bodies of `createPolicy`, `updatePolicy` and
  `pausePolicy` in its policies client. Thuli never calls any of them (searched every package). Its x402 guardrails
  validate with schemas from `@x402/core`, again on our `zod` 4.6.7, and they belong to the SDK's paying client, which
  Thuli does not use.
- The SDK does load its policy schemas when its x402 entry is imported. Building a schema is not the vulnerable step;
  validating an oversized collection with it is, and that never happens on our path.

Conclusion: the vulnerable `zod` copy is loaded but never asked to validate anything Thuli handles, so an attacker has
no way to hand it input.

## When to look again

- When `@coinbase/cdp-sdk` releases a version built on `zod` 4, upgrade to it and run the live paid proof.
- When `@openzeppelin/merkle-tree` releases a version on `@metamask/abi-utils` 3 or later, upgrade to it and check that
  the vault proof's roots still rebuild byte for byte.
- When `npm audit` shows any line that is not on this page.
