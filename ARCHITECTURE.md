# Thuli architecture

Thuli is Tamil for "a drop": every drop of an airdrop lands in a real hand.

Picked 27 Oct 2026: a screening service with an immutable reward vault on Base. The numbered
rules (C1 to C61) are in docs/security/threat-model.md. This file grows the interface section (addresses, ABI, the
exact reads and writes the UI makes) as the backend lands.

## 1. System overview

What runs today, drawn from the code on 11 Nov 2026. Solid lines are built. Every dashed line leads into the planned
box, and nothing in that box is built yet.

```mermaid
flowchart TB
  subgraph People["Who comes in"]
    VIS["Visitor or judge"]
    AGT["Paying agent"]
    WAL["Wallet"]
  end

  subgraph Web["Web app on Next.js, hosted on Vercel, holds no private key"]
    PAGES["Pages: home, replay, check, versions, break, docs, campaign"]
    FILES["Static replay files"]
    ROUTES["Routes: /api/check, /api/x402/*, /api/campaigns/*, /api/search"]
  end

  API["API package: free check, paid screen, campaign routes"]
  FAC["x402 facilitator"]
  DB[("Postgres at Neon: payment claims, leases, rate events, day counts, check cache, campaigns, asks, list versions, claim relays, appeals")]

  subgraph Worker["Worker: one process on Railway, and operator scripts"]
    LOOP["Campaign loop: screen an ask, publish the list, post the root, relay claims, check an appeal"]
    SCRIPTS["Replay, scoring, export and operator scripts"]
  end

  subgraph Screening["Screening code"]
    FACTS["Facts from public chain reads"]
    LIMITS["Start and ceiling set in code"]
    ASK["Ask SERV with the rules graph or the rulebook"]
    CHECKS["Output checks in code"]
  end

  ETH["Ethereum and Base RPC, Blockscout"]
  SERV["SERV Reasoning"]
  REPPO["Reppo evaluation API"]

  subgraph Base["Base Sepolia"]
    FACTORY["ThuliVaultFactory"]
    VAULT["ThuliVault, one per campaign"]
  end

  subgraph Planned["Planned, not built"]
    P1["Planned: paid data through Kite Passport, Nansen and Allium"]
    P2["Planned: Dolphin summaries"]
    P3["Planned: owner sign-in and campaign upload"]
    P4["Planned: owner settles appeals in the site"]
    P6["Planned: campaigns on Base mainnet"]
  end

  VIS --> PAGES
  AGT -->|"pays 0.05 USDC over x402"| ROUTES
  WAL -->|"signed ask, signed appeal, ticket"| ROUTES
  PAGES -->|"reads"| FILES
  PAGES -->|"free check"| ROUTES
  ROUTES -->|"all but /api/search"| API
  API -->|"settles payments"| FAC
  API --> DB
  API -->|"screens one wallet"| FACTS
  API -->|"claimed, claimable"| VAULT
  DB <-->|"asks, decisions, lists, relays, appeals"| LOOP
  SCRIPTS -->|"registers campaigns, settles appeals"| DB
  LOOP -->|"screens each ask"| FACTS
  LOOP -->|"VaultCreated log"| FACTORY
  LOOP -->|"postRoot, claim"| VAULT
  LOOP -->|"sends each appealed decision"| REPPO
  FACTORY -->|"creates"| VAULT
  VAULT -->|"pays"| WAL
  SCRIPTS -->|"replays a claim list"| FACTS
  SCRIPTS -->|"writes"| FILES
  SCRIPTS -->|"feedback"| REPPO
  FACTS -->|"public reads"| ETH
  FACTS --> LIMITS
  LIMITS --> ASK
  ASK <--> SERV
  ASK --> CHECKS

  FACTS -.-> P1
  FACTS -.-> P2
  API -.-> P3
  API -.-> P4
  VAULT -.-> P6

  classDef planned stroke-dasharray: 5 5
  class P1,P2,P3,P4,P6 planned
```

## 2. Main sequence: one wallet through an open campaign

One wallet from its signed ask to its payout, as the API, the store and the worker do it today. Every step here is in
the code; the worker runs as one process on a host (4.10).

```mermaid
sequenceDiagram
  autonumber
  participant W as Wallet
  participant API as Campaign routes
  participant DB as Postgres store
  participant K as Worker
  participant ETH as Ethereum and Base RPC
  participant SV as SERV Reasoning
  participant V as Vault on Base Sepolia
  participant R as Reppo evaluation API
  participant O as Operator command

  W->>W: Sign the ask text as a personal message
  W->>API: POST /api/campaigns/:id/asks with wallet, signedAt, signature
  API->>API: checkAsk: a valid address, signed in the last 600 seconds, the signature matches the rebuilt ask text
  API->>ETH: Only then read the wallet's code, a contract cannot ask yet
  API->>ETH: Read its sent count and balance on Ethereum, then on Base, a wallet with neither on both is answered neverUsed and nothing is stored
  API->>DB: Store the ask as queued while slots and room are left, the first ask per wallet stands
  API-->>W: 202 queued
  K->>DB: Take the oldest queued ask, leased for 300 seconds
  K->>ETH: Read the wallet's facts on the chain it was active on first, at that chain's latest finalized block, and its first funder's code and sent count
  K->>DB: Read the first funders of the campaign's other asks
  K->>K: Link asks that share a funder, set start and ceiling in code
  K->>SV: Facts, start and ceiling, through the rules graph or the rulebook
  SV-->>K: Action, rule, reason, cited transactions
  K->>K: Output checks, never above the ceiling
  K->>DB: Store the decision, an approved wallet takes the next free slot
  K->>DB: Build the list from the slot holders, store it as a new list version
  K->>K: Read the stored text back and rebuild the root from it
  K->>V: Check the vault against the factory log, simulate and sign postRoot
  K->>DB: Record the hash and nonce, the version is sending
  K->>V: Send the signed post and wait for its receipt
  K->>DB: Mark the version posted with the claimable time the receipt holds
  V->>V: The root waits out its delay, and the owner can cancel it
  K->>V: Read state, and claimed for every listed wallet
  K->>DB: Mark the version active, queue a relay for each wallet still owed
  K->>DB: Take the oldest waiting relay
  K->>V: Simulate, then send claim(account, cumulativeAmount, proof) from the agent key
  V-->>W: Pay the capped leaf amount minus what this wallet already received
  K->>DB: Mark the relay confirmed
  W->>API: GET /api/campaigns/:id/asks/:wallet
  API-->>W: The decision, and a claim ticket once the list is active
  W->>API: POST /api/campaigns/:id/appeals with wallet, one line of text, signedAt, signature (not approved in full)
  API->>DB: Store the appeal, bound to the decision it disputes
  K->>R: Send Thuli's decision with identifiers removed, never the appellant's text
  R-->>K: Route ship, review or block, and a note
  K->>DB: Store the route and note, the ask is unchanged
  O->>DB: Settle it: reversed to an approval, which takes the next free slot, or upheld
```

## 3. Module dependency graph

The packages and their main modules. An arrow points from a module to one it imports, and only the main imports are
drawn. The one dashed line is not an import: core's leaf and the vault hash a claim the same way.

```mermaid
flowchart TB
  subgraph web["packages/web"]
    PAGES["pages and components"]
    THULIAPI["lib/server/thuliApi"]
    RFILES["public/replay files"]
  end

  subgraph api["packages/api"]
    SITE["site, server, live"]
    APP["app, schema, receipt"]
    ACAMP["campaigns"]
    AREST["stores, claims, limits, guard, config"]
  end

  subgraph worker["packages/worker"]
    CAMPW["campaign: loop, screen, facts, publish, relay, vault, appeals"]
    SINGLE["screen/single"]
    REPLAY["replay: decide, runner, scoring, export"]
    REPPO["reppo: client, feedback"]
    SERVC["serv/client"]
    READ["facts/basic and chain readers"]
    VAULTW["vault: root, claimList, proof, chain, abi"]
  end

  subgraph store["packages/store"]
    SCAMP["campaigns, appeals"]
    SROWS["paymentClaims, limits, checkCache, sweep"]
    SDB["db, migrate"]
  end

  subgraph core["packages/core"]
    SIGN["ask, appeal"]
    DEC["start, ceiling, decision, graph"]
    FACTS["facts, factsEngine, settings"]
    LEAF["leaf"]
    MONEY["money"]
    ADDR["address, chains"]
  end

  subgraph contracts["packages/contracts"]
    VF["ThuliVaultFactory"]
    VA["ThuliVault"]
    OZ["OpenZeppelin: Ownable2Step, Pausable, ReentrancyGuard, SafeERC20, MerkleProof, Math, SafeCast"]
  end

  PAGES --> RFILES
  THULIAPI --> SITE
  SITE --> APP
  SITE --> SINGLE
  APP --> ACAMP
  APP --> AREST
  AREST --> SROWS
  ACAMP --> SCAMP
  ACAMP --> SIGN
  ACAMP --> VAULTW
  CAMPW --> SINGLE
  CAMPW --> REPLAY
  CAMPW --> VAULTW
  CAMPW --> REPPO
  CAMPW --> SCAMP
  SINGLE --> READ
  SINGLE --> REPLAY
  REPLAY --> SERVC
  REPLAY --> READ
  REPLAY --> DEC
  REPPO --> REPLAY
  READ --> FACTS
  SERVC --> DEC
  VAULTW --> LEAF
  VAULTW --> MONEY
  SCAMP --> SDB
  SROWS --> SDB
  SCAMP --> DEC
  SIGN --> DEC
  DEC --> FACTS
  FACTS --> ADDR
  LEAF --> ADDR
  VF --> VA
  VA --> OZ
  LEAF -.-|"same encoding"| VA
```

## 4. Interface for the frontend

This is what the web app builds against: where the contracts live, what each call does and how it fails, the paid API,
and the shapes the screens read. Every fact here was taken from the code on 11 Nov 2026. Where this section and the
code disagree, the code is right and this section needs an update.

### 4.1 Deployed contracts

Everything runs on Base Sepolia, Base's public testnet, with test money. There is one factory there, and one vault made
from it by the vault proof run. The vault factory was also deployed on Base mainnet on 11 Nov 2026, at 16:31 UTC. Its
runtime code is identical to the Base Sepolia factory, and its source is verified on Basescan. On 12 Nov 2026 it made
one proof vault, 0x52e9F0D7b48a7bbAf5700433810c41C96CfBC40C, which ran once with real USDC: 2 USDC deposited, a cap of
1 USDC, a one-hour delay, one listed wallet paid exactly 1 USDC by a claim the worker submitted, and the remaining
1 USDC withdrawn by the owner after the end. Its record is packages/contracts/deployments/base-proof.json, and
`npm run prove:vault -- verify --network base --real-money` checks it against Base in 17 checks. The public campaign and
every other address below stay on Base Sepolia with test money. The deploy script deploys to Base only with both `--network base` and
`--real-money`.

| What | Value |
| --- | --- |
| Base mainnet factory | `0x1d9b8cd9a5af33287bb96862d9bb0f563dc402de`, chain id `8453`, https://basescan.org/address/0x1d9b8cd9a5af33287bb96862d9bb0f563dc402de |
| Base mainnet deploy transaction | `0x2f0088506ef05f2a9c435b9fc141ad60c399380126d4c6670f5bcaf1dfe9bff3`, block `56121245` |
| Base mainnet record | `packages/contracts/deployments/base.json` |
| Network of every row below | Base Sepolia, chain id `84532` |
| ThuliVaultFactory | `0xbd2c20d2a068fe6d5052efca910d1cba44638b56` |
| Verified source | https://base-sepolia.blockscout.com/address/0xbd2c20d2a068fe6d5052efca910d1cba44638b56 |
| Factory deploy transaction | `0x5019bb52542ab56a619a0512a97fe1ad9bec61635025871b11fca532224df7f7`, block `57247894` |
| Deployment record | `packages/contracts/deployments/base-sepolia.json`, written by `npm run vault:deploy` |
| Proof vault | `0xAdb8aD5A8BC359fF17D81DBe41833bB6b26B2034`, created in block `57248098` |
| Proof vault record | `packages/contracts/deployments/base-sepolia-proof.json`, rebuilt by `npm run prove:vault -- record`, which reads the run back from Base Sepolia, loads no key and sends nothing. |
| Check the record yourself | `npm run prove:vault -- verify` checks the committed record against Base Sepolia line by line (each of the five receipts with its block, sender and gas, the VaultCreated, RootPosted, Claimed and USDC Transfer events in them, and the vault's `state()` and `claimed()` today), and needs only the two committed records and an RPC URL, the public `https://sepolia.base.org` when `BASE_SEPOLIA_RPC_URL` is unset. |

The proof vault pays Base Sepolia test USDC, caps each wallet at 1 USDC, holds 2 USDC, delays every root by one hour,
and was created to take claims until unix `1794976286` (18 Nov 2026, 04:31:26 UTC). On 11 Nov 2026 the owner moved
the end to unix `1804756909` (11 Mar 2027, 09:21:49 UTC) with `extendEnd`, in transaction
`0x37f8a85af0c454c01a1477dca238edc05ffe4e5a2e75ab410998f0a566459dd6`, so the attack page keeps reading a vault that is
still open. Its first root lists one wallet at 1 USDC and
became claimable at unix `1794375097` (11 Nov 2026, 05:31:37 UTC). The record holds five transactions: the four setup
ones (createVault, approve, deposit, postRoot) and the claim.
Show live values from `state()` (4.2), never from these notes: the end time moves when the owner extends it or pauses.

The two records write addresses in different letter case (the factory lowercase, the vault checksummed). Case does not
change an address, so put both sides through `parseAddress` from `@thuli/core` before comparing.

### 4.2 The vault

Each campaign gets its own ThuliVault from the factory. The project running the campaign is the owner: it funds the
vault, can cancel a root while the root waits out its delay, can pause, and takes back what is left after the end.
Thuli's worker key is the agent, and all it can do is post roots. Anyone can submit a claim, and the tokens always go
to the wallet named in the leaf.

The ABI to import is `packages/worker/src/vault/abi.ts` (`@thuli/worker/src/vault/abi.ts`): `VAULT_ABI` and
`FACTORY_ABI`, both declared `as const` so viem types every read and write. The file is generated from the compiler
output in `packages/contracts/out`, a test fails if they drift apart (it skips when `out` has not been built), and it
imports nothing, so it is safe in a browser bundle. `VAULT_ABI` carries every custom error, OpenZeppelin's included.
`FACTORY_ABI` carries none, so decode a failed `createVault` against `VAULT_ABI`: the constructor's errors pass
through the factory unchanged.

Who may call: "owner" is `owner()`, "agent" is `agent()`, "pending owner" is `pendingOwner()`. Anyone else calling an
owner function gets `OwnableUnauthorizedAccount(address account)`.

#### Factory

| Function | Who | Reverts with | Emits |
| --- | --- | --- | --- |
| `createVault(address token, address owner, address agent, uint256 perWalletCap, uint64 endTime, uint32 rootDelay) returns (address vault)` | anyone | `OwnableInvalidOwner` (zero owner), `ZeroAddress` (zero token or agent), `AgentIsOwner`, `ZeroCap`, `RootDelayOutOfRange(rootDelay)` (outside 1 hour to 30 days), `EndTimeTooSoon(endTime, earliest)` (before now plus the root delay plus 1 hour), `EndTimeOutOfRange(endTime)` (more than 365 days out) | `VaultCreated(address indexed vault, address indexed owner, address indexed agent, address token, uint256 perWalletCap, uint64 endTime, uint32 rootDelay)`; the new vault emits `OwnershipTransferred` and `AgentChanged` |

The factory has no owner and no settings. Anyone can call `createVault` and name any address as owner, so a list of
vaults built from `VaultCreated` events must not treat an event as proof that the named owner asked for that vault. To
learn the new vault's address, read `vault` from the `VaultCreated` log in the receipt, keeping only logs from the
factory's address; the proof run does this and checks it against the simulated return value.

#### Vault writes

| Function | Who | Reverts with | Emits |
| --- | --- | --- | --- |
| `deposit(uint256 amount)` | owner, before the end; the owner first calls `approve(vault, amount)` on the reward token | `ZeroAmount`, `CampaignEnded`, `FeeOnTransferToken(expected, received)`, or the token's own error (or `SafeERC20FailedOperation`) when the allowance or balance is short | `Deposited(address indexed from, uint256 amount, uint256 totalDeposited)` |
| `postRoot(bytes32 root, uint256 declaredTotal)` | agent only; the web app never sends this | `NotAgent(caller)`, `EnforcedPause`, `ZeroRoot`, `CampaignEnded`, `DeclaredTotalAboveDeposit(declaredTotal, deposited)`, `RootWouldNotActivate(claimableAt, endTime)` | `RootActivated` when a pending root was already due, `RootCancelled` for a pending root it replaces, then `RootPosted(bytes32 indexed root, uint256 declaredTotal, uint64 claimableAt)` |
| `cancelRoot()` | owner, while the pending root is still inside its delay, paused or not | `NoPendingRoot`, `RootAlreadyClaimable(claimableAt)` | `RootCancelled(bytes32 indexed root)` |
| `setAgent(address newAgent)` | owner | `ZeroAddress`, `AgentIsOwner` | `RootActivated` when a pending root was already due, `RootCancelled` for a pending root still inside its delay, then `AgentChanged(address indexed previousAgent, address indexed newAgent)` |
| `extendEnd(uint64 newEnd)` | owner, before the end | `CampaignEnded`, `EndTimeOutOfRange(endTime)` when `newEnd` is not later than the current end or is more than 365 days from now | `EndExtended(uint64 previousEnd, uint64 newEnd)` |
| `pause()` | owner | `EnforcedPause` when already paused | `RootActivated` when a pending root was already due, then `Paused(address account)` |
| `unpause()` | owner | `ExpectedPause` when not paused | `Unpaused(address account)`; when any time passed while paused, `RootDelayed(bytes32 indexed root, uint64 claimableAt)` for a pending root and `EndExtended`. The end time and any pending root move later by exactly the time spent paused. |
| `claim(address account, uint256 cumulativeAmount, bytes32[] proof)` | anyone; the tokens go to `account` | `EnforcedPause`, `ZeroAddress`, `CampaignEnded`, `NoClaimableRoot`, `InvalidProof`, `NothingToClaim(account)`, `DepositExhausted(amount, available)` | `RootActivated` when it records a due root, then `Claimed(address indexed account, uint256 amount, uint256 cumulative)` |
| `withdrawAfterEnd(address to)` | owner, from the end time on, not while paused; sends the whole reward token balance | `EnforcedPause`, `ZeroAddress`, `CampaignNotEnded`, `NothingToWithdraw` | `Withdrawn(address indexed to, uint256 amount)` |
| `rescue(address otherToken, address to, uint256 amount)` | owner, any time; never the reward token | `RewardTokenNotRescuable`, `ZeroAddress`, `ZeroAmount` | `Rescued(address indexed token, address indexed to, uint256 amount)` |
| `transferOwnership(address newOwner)` | owner; the zero address cancels a transfer in progress | `AgentIsOwner` | `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` |
| `acceptOwnership()` | pending owner | `OwnableUnauthorizedAccount`, `AgentIsOwner` when the pending owner has since become the agent | `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` |
| `renounceOwnership()` | nobody: declared `pure` and always reverts | `RenounceDisabled` | nothing. Leave it out of the UI. |

`deposit`, `claim`, `withdrawAfterEnd` and `rescue` are also guarded against reentry (`ReentrancyGuardReentrantCall`).

`RootActivated` fires only when some transaction records the activation (a claim, a new root, a pause or an agent
change). A root starts paying the moment its delay ends, before any such event, so show the active root from
`state()`, never from the event log.

#### Vault reads

Use `state()` for the vault page. It returns a struct (`VaultState memory`), so viem hands back an object with named
fields. Every other view returns a single value, and viem returns that value directly. The vault has one public
mapping, `claimed`, and it holds a plain number, not a struct, so no read anywhere returns a tuple to unpack by
position. viem decodes `uint32` as a JavaScript number and `uint64` and `uint256` as bigint; the worker's own reads
rely on this.

`state()` fields, in order:

| # | Field | Solidity | viem | Meaning |
| --- | --- | --- | --- | --- |
| 1 | `token` | address | string | the reward token |
| 2 | `owner` | address | string | the project running the campaign |
| 3 | `agent` | address | string | the root-posting key |
| 4 | `perWalletCap` | uint256 | bigint | the most one wallet can ever receive, in token base units |
| 5 | `endTime` | uint64 | bigint | claims are accepted while block time is below this, withdrawal from it on |
| 6 | `rootDelay` | uint32 | number | seconds every root waits before it pays |
| 7 | `deposited` | uint256 | bigint | everything the owner has deposited |
| 8 | `totalPaid` | uint256 | bigint | everything paid to claimants |
| 9 | `activeRoot` | bytes32 | hex string | the root claims prove against; a pending root whose delay is over already shows here |
| 10 | `pendingRoot` | bytes32 | hex string | the root waiting out its delay, all zeros when there is none |
| 11 | `pendingClaimableAt` | uint64 | bigint | when the pending root starts paying, zero when there is none; while paused, the time it would have if the vault were unpaused now |
| 12 | `paused` | bool | boolean | whether the vault is paused |

Other views:

| View | Solidity | viem | Notes |
| --- | --- | --- | --- |
| `claimable(address account, uint256 cumulativeAmount)` | uint256 | bigint | what a claim with a valid proof would pay right now. It does not check the proof. Zero when paused, ended, no claimable root, nothing new for this wallet, or not enough deposit left. |
| `claimed(address account)` | uint256, public mapping getter | bigint | everything the account has received from this vault |
| `token()`, `owner()`, `pendingOwner()`, `agent()` | address | string | `pendingOwner` is zero when no transfer is in progress |
| `perWalletCap()`, `deposited()`, `totalPaid()` | uint256 | bigint | the same values `state()` gives |
| `endTime()` | uint64 | bigint | |
| `rootDelay()` | uint32 | number | |
| `paused()` | bool | boolean | |
| `MIN_ROOT_DELAY()`, `MAX_ROOT_DELAY()`, `MIN_CLAIM_WINDOW()` | uint32 | number | 1 hour, 30 days, 1 hour, in seconds |
| `MAX_END_AHEAD()` | uint64 | bigint | 365 days, in seconds |

The roots have no getters of their own; read them from `state()`.

### 4.3 Leaves and proofs

A claim list becomes one Merkle root on the vault. Each wallet's leaf holds its total entitlement across every root so
far, and the vault pays the difference from what it has already paid that wallet, never more than the per-wallet cap.

The leaf, exactly as the vault hashes it:

```text
leaf = keccak256(bytes.concat(keccak256(abi.encode(uint256 chainId, address vault, address account, uint256 cumulativeAmount))))
```

This is OpenZeppelin StandardMerkleTree's leaf for the types `['uint256', 'address', 'address', 'uint256']`, and the
vault checks proofs with OpenZeppelin `MerkleProof.verifyCalldata`. The chain id and the vault address sit inside the
leaf, so a proof for one vault or chain is worthless on another.

The functions that build leaves, trees and proofs:

- `leafValues(chainId: number | string, vault: string, account: string, cumulativeAmount: bigint): LeafValues` in
  `packages/core/src/leaf.ts`. One leaf as text, `[chainId, vault, account, cumulativeAmount]`: chain id and amount as
  decimal text, both addresses checksummed. Throws `AddressError`, `ChainError` (a chain not in core's list: 1, 8453,
  84532) or `LeafError` (the amount is not a bigint inside uint256).
- `buildTree(entries: readonly LeafValues[]): LeafTree` in the same file. Refuses an empty list, an entry not made by
  `leafValues`, mixed chains or vaults, and a wallet listed twice.
- `proofFor(tree: LeafTree, account: string): MerkleHash[]` in the same file. The `bytes32[]` proof for one wallet,
  written in any address spelling. Throws `LeafError` when the wallet has no leaf.
- `buildRoot(entries: readonly VaultEntry[], vault: string, chainId: number | string): { root, tree }` in
  `packages/worker/src/vault/root.ts`. `leafValues` plus `buildTree` for a whole list, where `VaultEntry` is
  `{ account: string; cumulativeAmount: bigint }`.
- `publishList(entries): string` and `readPublishedList(text: string): VaultEntry[]` in the same file. The published
  list is a JSON array of `{ "account": checksummed address, "cumulativeAmount": decimal string }`, at most 100,000
  entries, and anyone can rebuild the root from it.

The first three are exported by `@thuli/core`, whose entry point is its TypeScript source (`packages/core/src/index.ts`).
The last two live in the worker.

What a claimant's browser needs to hold to claim:

- `account`: the wallet in the leaf. The transaction can come from any wallet, because the vault always pays `account`.
- `cumulativeAmount`: the leaf's amount as a bigint, in the reward token's base units (USDC has 6 decimals, so 1 USDC
  is `1000000`).
- `proof`: the `bytes32[]` from `proofFor`, built from the same published list the root was built from.
- the vault address, on chain `84532`.

Before sending, call `claimable(account, cumulativeAmount)` to show what the claim would pay (zero means nothing to
claim now), then simulate `claim(account, cumulativeAmount, proof)` so an `InvalidProof` shows before the wallet asks
for a signature. The proof run does the same: it rebuilds the tree from the published list, checks the rebuilt root
equals `state().activeRoot`, reads `claimable`, then simulates and sends `claim`.

A decision's share becomes a leaf amount through `shareOf` in `packages/core/src/money.ts`, and `buildClaimList` and
`claimTicket` in `packages/worker/src/vault/claimList.ts` build a campaign's list and one wallet's claim ticket. The
campaign routes serve a wallet its claim ticket (4.9), and the campaign worker posts lists and submits claims (4.10).

### 4.4 The paid API

One paid route screens one Ethereum wallet for $0.05 in USDC, paid over x402 (HTTP 402 payments). The usual buyer is an
agent or a script, and a "check a wallet" screen can buy the same way. The payment settles before the screening runs.
One payment buys one result for the wallet it was made for: at most two screenings are started for it, the result is
stored with the payment, and the same payment header fetches it again for a day.

| Route | Method | Price | Limits apply |
| --- | --- | --- | --- |
| `/api/x402/screen` | POST | `$0.05`, exactly `50000` USDC base units | yes |
| `/api/x402/health` | GET | free | no |

Request: `content-type: application/json` and a body of exactly `{"wallet": "0x..."}`: one key, a string of at most 64
characters, at most 1 KB in all. The address may be all lowercase, all uppercase, or mixed case with a correct
checksum.

Payment header: `PAYMENT-SIGNATURE` (x402 version 2). `X-PAYMENT`, the version 1 name, is read too. The x402 client
libraries build the header from the 402 terms: `wrapFetchWithPayment` in `@x402/fetch`, or
`x402HTTPClient.encodePaymentSignatureHeader` in `@x402/core/client`, with `ExactEvmScheme` from
`@x402/evm/exact/client`. All x402 packages are pinned at 2.30.0.

The 402 answer. With no payment header, the route answers 402 with the JSON body `{"error": "Payment required"}` and
the terms in the `PAYMENT-REQUIRED` header, which is base64 of a JSON object:

- `x402Version`: `2`
- `error`: `"Payment required"`
- `resource`: `{ url, description, mimeType: "application/json" }`. `url` is the server's public origin plus the path:
  `PUBLIC_ORIGIN`, or else the production host Vercel names in `VERCEL_PROJECT_PRODUCTION_URL`, both held to the same
  shape. A server on Base mainnet needs one of them. With neither, on Base Sepolia, it is the request's own URL.
- `accepts`: one entry, `{ scheme: "exact", network, amount: "50000", asset, payTo, maxTimeoutSeconds: 300, extra }`.
  `network` is `eip155:84532` on Base Sepolia or `eip155:8453` on Base. `asset` is that network's USDC:
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` on Base Sepolia, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base.
  `extra` holds `paymentFlow: "upfront"` plus any token details the x402 library adds for signing.
- `extensions.bazaar`: the discovery listing, with an input example and the JSON schema of the success body below. A
  settled payment that carries it asks the facilitator's catalogue to list the route. A server only its own machine can
  reach is started with `unlisted` and sends none: the proof script's own server is.

A request that looks like a browser page load (an Accept header with `text/html` and a Mozilla user agent) gets the
x402 library's HTML paywall instead of the JSON body. A `fetch` from the web app does not, unless it sets that Accept
header.

The success answer is 200, with a `PAYMENT-RESPONSE` header (base64 JSON with `success: true`, `transaction`,
`network`, `payer`) and exactly this body:

| Field | Type |
| --- | --- |
| `wallet` | checksummed address, the one paid for |
| `checkedAt` | ISO 8601 date and time |
| `scope` | always `"one wallet on Ethereum, no claim list"` |
| `rulebook` | always `"v2"` |
| `decision.action` | `"full"`, `"partial"`, `"hold"` or `"exclude"` |
| `decision.shareBps` | whole number from 0 to 10000: full is 10000, partial is the settings' partial share (5000 by default), hold and exclude are 0 |
| `decision.rule` | `A1` to `A9`, `B1` or `B2` |
| `decision.reason` | 1 to 400 characters of plain text by core's one plain-text rule (`isPlainText`): no link, markup, control character or invisible format character |
| `decision.citedTxs` | up to 256 transaction hashes, each `0x` and 64 lowercase hex |
| `servRequestId` | SERV's run id (letters, digits, `.`, `_`, `:`, `-`, up to 128 characters) or null |
| `notChecked` | the facts this screening never measures, today always `["group", "sharedDepositAddress", "fundingBurst", "claimPaidToOtherAddress"]` |
| `payment.network` | `"eip155:84532"` or `"eip155:8453"` |
| `payment.payer` | checksummed address that paid |
| `payment.transaction` | the settlement transaction hash, `0x` and 64 lowercase hex |

A paid request always gets a decision. If the screening fails, or its result fails the output check, the body is a hold
with rule `A1` and a reason reading `Held for review: <cause>.` Every `reason` that leaves the route, a stored one read
back included, passes core's plain-text rule first; one that fails it is replaced by the hold reading `Held for
review: the result did not pass the output check.` Show `reason` as text only, never as HTML or markdown.

One deadline. Every paid request answers by `REQUEST_DEADLINE_MS`, 240 seconds after its first line
(`packages/api/src/config.ts`). The site's host ends a request at 300 seconds whatever it is doing, so this leaves a
minute. Every wait in the request is held to it: the body read, each store call, the receipt read, the settle calls and
the screening, which is stopped through a signal when its share of the time runs out. Two rules keep a request from
settling a payment it cannot finish:

- It settles nothing unless `SETTLE_ROOM_MS` is left, 120.5 seconds: two settle calls of up to 30 seconds each
  (`SETTLE_TIMEOUT_MS`; a pending settlement is asked once more), the slowest receipt read, 40.5 seconds
  (`RECEIPT_READ_WORST_MS`, two tries of two 10 second calls), and the 20 seconds a screening needs to start. With less,
  the answer is 503 `{"busy": true}` and nothing is claimed or settled, so nothing is spent.
- After settling, a screening starts only with `SCREEN_LEAST_MS` left, 20 seconds. Its time is what is left less a 10
  second margin for storing the result (`REPLY_MARGIN_MS`), and never more than its own 120 seconds.

The facilitator's verify call is cut at 15 seconds (`VERIFY_TIMEOUT_MS`), each settle call at 30, and the supported-kinds
call each server copy makes once before its first payment at 30. A call cut off may still finish at the facilitator; the
claim, kept unsure, is what makes that safe.

What a payment buys. A payment claim lives in the store (`payment_claims`, migrations `004_paid_results.sql`,
`007_screening_tries.sql`, `012_named_transactions.sql` and `013_claim_wallet.sql`) in one of these states: held (one request is settling it), unsure (the settlement's outcome is
not known), settled (the money moved and no result is stored yet) and served (the result is stored with the claim). A
claim written before migration 004 is kept as used and is never redeemed.

For a day from the settlement (`PAID_RESULT_KEEP_SECONDS`, 86,400 seconds) the same payment header, with the same wallet
in the body, is redeemed instead of settled again. The reply is stored on the claim before it is sent, so a reply lost on
the way can be fetched again.

| What the claim is | What the same header gets |
| --- | --- |
| served | The stored body, exactly as stored, with the response header `thuli-stored-result: true`. No settlement and no screening. |
| settled, no request is screening it | A screening, by this request. |
| settled, another request is screening it now | 503 with the settled-retry body below and `Retry-After: 10`. Never "used up". |
| settled or served for another wallet | 402, refused as a used payment (`payment_already_used`), and nothing runs. |
| unsure, first taken for another wallet | The same 402. A claim is taken again only for the wallet it was first taken for. |
| unsure, for this wallet, holding a transaction a facilitator named | Asked of the facilitator again while the payment is inside its validBefore, and served once that transaction's receipt proves the payment. Kept for a day past the payment's validBefore. |
| more than a day old | Nothing: the claim is gone, and the header is treated as a new payment. |

A redeem passes the same client and service limits as any paid request and never counts as a failed payment.

At most `REDEEM_SCREEN_TRIES`, two, screenings are started for one payment. The count rises in the same store step that
gives a request the claim, so two requests can never both start the last try, and a try a request took and never started
is handed back. A screening that runs out of time before the last try answers the settled-retry body and the payment stays
settled, so the same header gets another screening. When the last try runs out of time, or both tries are used and none
stored a result, the hold `the screening ran out of time` (rule `A1`) is stored and served as the result. So a settled
payment always ends with a stored result, after at most two screenings.

When a screening is cut because its share of the time ran out, it is stopped through its signal and no further SERV call
starts. The caller's running place, the service's place and the payment's claim stay taken until that screening has really
ended, so the ceilings still count it and no redeem starts beside it. The reply does not wait for it.

Once a settlement is confirmed, the buyer always gets the result, whatever happens to the store that keeps the claims
and limits. If the store cannot mark the payment settled, count the screening or store the result, the failure is logged
and the reply still goes out. A claim the store could not mark settled stays held until the sweep clears it, so no
copy of the header is served, and that payment cannot be redeemed. A result the store could not keep is screened again on
the next redeem. Before a settlement is confirmed, a store that cannot be reached refuses instead (the two `503` rows
below), and nothing is settled on a claim the store could not record.

Errors, in the order the route checks for them:

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"error": "the client address could not be read"}` | the caller's IP address is unknown (see mounting below) |
| 429 | `{"busy": true}` | this caller is past one of its own limits |
| 503 | `{"busy": true}` | the store that keeps the limits could not be reached; nothing was asked for or run |
| 413 | `{"error": "the body is too large"}` | the body is over 1 KB |
| 400 | `{"error": "the body must be JSON like {\"wallet\": \"0x...\"}"}` | the body is not JSON |
| 400 | `{"error": "the body must be exactly {\"wallet\": \"0x...\"}"}` | other keys, or `wallet` is not a string of at most 64 characters |
| 400 | `{"error": "wallet rejected: <cause>"}` | the cause is `not a 0x address of 40 hex characters` or `mixed-case address with a wrong checksum, likely a typo` |
| 503 | `{"busy": true}` | the server is at its own ceiling (limits below), or its memory of payments is full |
| 503 | `{"busy": true}` | the store that keeps the ceilings could not be reached; no payment was asked for |
| 402 | `{"error": "Payment required"}` with `PAYMENT-REQUIRED` | no payment header |
| 402 | `{"error": "No matching payment requirements"}` with a fresh `PAYMENT-REQUIRED` | the payment header does not match the terms |
| 402 | `{}` with `PAYMENT-RESPONSE` holding `success: false` and an `errorReason` | the payment was refused at settlement. Thuli's own reasons: `payment_not_understood`, `payment_terms_mismatch`, `payment_expired`, `payment_valid_too_long` (signed to stay valid past 300 seconds plus a 30 second clock allowance), `payment_already_used`. A settle the facilitator answers as plainly failed (a 200 with `success: false` and no pending reason) carries the facilitator's reason, and an authorization that was already past its validBefore when the request came is answered `payment_expired` without the facilitator being asked; in both cases only when no named transaction's receipt is left to wait for. |
| 503 | `{"busy": true}` | under 120.5 seconds of the deadline are left, so nothing was claimed or settled |
| 503 | `{"retry": true}` | the store could not record the claim on this payment, so it was not settled. Send the same payment header again. |
| 503 | `{"retry": true}` | the settlement's outcome is unknown: a named transaction whose receipt is not there yet, no answer, a timeout, any error answer from the facilitator or an answer that says pending. A named transaction stays with the claim until its receipt is read (at most 8 wait at once, the oldest giving way), and a later copy of the header for the same wallet is served once a receipt proves the payment. Coinbase's facilitator refuses a payment it will not send with a 400 that names no transaction, the shape a second settle of a paid authorization would also get, so that answer is unknown too and a buyer short of funds is not told why. Send the same payment header again; it can never pay twice. |
| 503 | `{"settled": true, "retry": true, "message": "The payment has settled. Send the same payment header again to get the screening it bought."}` with `Retry-After: 10` | the payment settled and no result is stored yet: under 20 seconds were left to screen, a screening before the last try ran out of time, or another request is screening this payment now. Send the same payment header again; it is never charged again. |
| 500 | `{"error": "the payment could not be confirmed"}` or `{"error": "internal error"}` | an internal fault; no detail is returned |

Limits. With `DATABASE_URL` set, the payment claims, these limits and the day count live in Postgres and are shared by
every copy of the server, so a host that runs many short-lived copies still has one allowance and one memory of
payments. A place a copy took and never gave back, because it crashed, frees itself after 330 seconds
(`LEASE_SECONDS`), 90 seconds longer than the 240 second deadline. Without `DATABASE_URL`
they live in each process's memory, count per process, and reset on a restart, which is right only for one long-running
server. A caller is its IP address: IPv4 as it is, IPv6 grouped by its /64 network.

| Limit | Value |
| --- | --- |
| Time for a whole paid request | 240 seconds, then it has answered |
| Screenings one payment buys | 2 |
| Time a settled payment's result can be fetched again | 1 day from the settlement |
| Paid requests in flight per caller | 1 |
| Requests per caller in any 60 seconds, paid or not | 20 |
| Paid attempts per caller in any hour that end without a settled payment | 5 |
| Callers tracked at once | 100,000 in memory, the least recently seen idle caller forgotten first. The shared store has no such cap; a regular sweep deletes rows no limit needs any more |
| Paid requests in flight on the whole service | 4 |
| Screenings started per UTC day on the whole service | 600 in memory. The shared store stops new paid requests 4 short, at 596, so the four that may be running can always finish without passing 600 |
| SERV calls per screening | 12 |
| Time per screening | 120 seconds, then a hold |

Named limits of the paid route:

- A crash in the instant between the facilitator settling a payment and the store recording it as settled leaves that
  payment unredeemable. The settlement is on chain and the payment is refunded by hand.
- A redeem does not check the signature again. It returns only the stored result of the wallet the payment was for, so
  anyone who rebuilds the header from the settlement on chain can fetch that wallet's result. It buys no screening the
  payment did not already buy, and the free check gives any wallet's screening to anyone.
- When a settlement's outcome is unknown and keeping the claim as unsure fails as well, the claim stays held by a request
  that is gone, so the same header cannot retry before it expires. That takes two failures at once.

Health: `GET /api/x402/health` returns `{"network": "eip155:84532", "payTo": "<address>", "price": "$0.05", "scope":
"one wallet on Ethereum, no claim list"}`, with `network` set to `eip155:8453` on Base. No payment, no limits.

Mounting. The API is a Hono app built by `createApp(config: ApiConfig, deps: ApiDeps): Hono` in
`packages/api/src/app.ts`. Its routes carry their full paths, and the website serves them itself:
`packages/web/app/api/x402/[...path]/route.ts` and `packages/web/app/api/check/[[...path]]/route.ts` hand every GET and
POST under `/api/x402/` and `/api/check` to the app unchanged, and `packages/web/app/api/campaigns/[...path]/route.ts`
does the same for `/api/campaigns/`. All three run on Node.js, are always dynamic, and allow 300 seconds, the host's own
limit, which the app's 240 second deadline stays under. Every answer, whatever its status, carries
`cache-control: no-store`, on the site and on the standalone server alike.

Inside the site, `thuliApi()` in `packages/web/lib/server/thuliApi.ts` builds the API once per server copy, from the
process environment, through `siteApi(env, files)`, the API package's one entry (`@thuli/api/site`, source
`packages/api/src/site.ts`). The site's settings are the names in `.env.web.example` at the repository root. The stores:

- With `DATABASE_URL` set, Postgres through `connectPostgres`, shared by every copy. The schema is brought up to date
  once, before the first request is handled.
- With `DATABASE_URL` unset outside production, an in-process Postgres, with one warning that its state is lost on
  restart.
- In production the site needs both `DATABASE_URL` and `TRUSTED_CLIENT_HEADER`. Without either, or with any setting
  missing, malformed or forbidden (a variable ending in `PRIVATE_KEY` included), there is no API: every request answers
  503 `{"busy": true}` and the cause is logged once, by variable name, never with a value. The site never serves a
  result from a half-configured API. Production means `NODE_ENV` as the server runs, not as the site was built.

The rulebook and the store's migrations travel inside the server bundle as text, so they load wherever the built site
runs, whatever path the host gives its files. The pieces the site and the standalone server share:

- `loadApiConfig(env)` in `packages/api/src/config.ts` reads and checks the settings: `X402_NETWORK` (`base` or
  `base-sepolia`, no default); `PAYTO_ADDRESS_TESTNET` on Base Sepolia or `PAYTO_ADDRESS` on Base; `CDP_API_KEY_ID`,
  `CDP_API_KEY_SECRET`, `BASE_RPC_URL` and a public origin (`PUBLIC_ORIGIN` or Vercel's production host) on Base; optional `FACILITATOR_URL` on Base Sepolia;
  optional `TRUSTED_CLIENT_HEADER`; optional `DATABASE_URL`, a `postgres://` or `postgresql://` URL; and `PORT` for the
  standalone server. It refuses to start while any variable whose name ends in `PRIVATE_KEY` is set, so the web app's
  server environment must hold no private key. The database URL holds a password, so it is kept out of anything that
  prints the config, and no error message contains it.
- `deps.stores` is where the claims, limits and cached checks live: `postgresStores(connectPostgres(url), now)` from
  `packages/api/src/stores.ts` when `DATABASE_URL` is set, and this process's memory when it is left out. The app
  starts a sweep of the store on every 200th request without waiting for it. The sweep keeps a settled or served claim
  for a day from its settlement and deletes it after.
- `liveScreen(env, rulebook?)` in `packages/api/src/live.ts` returns `deps.screen`, the real screening (4.5), a function
  of a wallet and an optional abort signal. It reads the rulebook from the repository unless it is handed the text, as
  the site hands it the copy in its bundle.
- `packages/api/src/server.ts` runs the same app on its own, on port 8787 by default (`npm run api:dev`). With
  `DATABASE_URL` set it brings the schema up to date once at start, then sweeps at start and every 10 minutes.

The standalone server reads the caller's IP from the Node socket through `@hono/node-server`. A Next.js route handler
has no socket, so inside the site the caller comes from a header. In production that is `TRUSTED_CLIENT_HEADER`, which
must name the header the host writes the caller's IP into, `x-vercel-forwarded-for` on Vercel. Outside production it is
`x-forwarded-for`, which Next's own server fills from the socket when a request carries none.

The API package exports only `@thuli/api/site`. Its declaration, `packages/api/site.d.ts`, is all the site's TypeScript
sees, because the package's sources import with `.ts` extensions the site's settings do not allow. A test fails to
compile if the declaration and the source ever disagree.

### 4.4b The free check

`POST /api/check` is what the site's check box calls: anyone pastes a wallet and gets a decision, with no sign-in and
no payment. It runs the same screening as the paid route (4.5). It never buys data and never asks for or takes a
payment, so its only cost is model credit, and that cost has the ceilings below (C24).

`GET /api/check/health` returns `{"scope": "one wallet on Ethereum, no claim list", "rulebook": 2, "price": "free"}`.

Request: the paid route's rules exactly. `content-type: application/json`, a body of exactly `{"wallet": "0x..."}`, at
most 1 KB, the same address parsing and the same error bodies.

The success answer is 200 with exactly this body, the paid reply's fields without `payment` and with `cached`:

| Field | Type |
| --- | --- |
| `wallet` | checksummed address, the one checked |
| `checkedAt` | ISO 8601 date and time of the screening; a cached answer keeps the time of its first screening |
| `scope` | always `"one wallet on Ethereum, no claim list"` |
| `rulebook` | always `"v2"` |
| `decision` | `action`, `shareBps`, `rule`, `reason` and `citedTxs`, exactly as in the paid reply (4.4) |
| `servRequestId` | SERV's run id or null |
| `notChecked` | the facts this screening never measures, as in the paid reply |
| `cached` | `true` when the answer came from the cache, `false` for a new screening |

The body passes the same output check as the paid reply. A screening whose result fails it becomes a hold on `A1`
reading `Held for review: the result did not pass the output check.`, and a screening that fails becomes a hold on `A1`
with its cause. Show `reason` as text only.

Cache. Results are kept by canonical address, chain 1 and rulebook version, so every spelling of one wallet shares one
entry and one model run. A result the rulebook's checks accepted is kept 24 hours. A hold because the screening failed
or its answer was refused is kept 5 minutes, so an outage is not frozen in for a day and still cannot be hammered. A
cached answer is checked like a new one before it goes out. With `DATABASE_URL` set the cache is shared by every copy of
the server; without it each process keeps at most 10,000 answers and forgets expired ones first.

One screening per wallet at a time. While a screening of an address runs, another request for that address, in any
spelling, gets 202 with exactly `{"pending": true}` and starts nothing. Ask again a few seconds later: once the screening
ends the answer is in the cache. A screening can take up to 120 seconds.

Ceilings. A cached answer runs nothing and counts toward none of these but the first. Only a check that starts a
screening counts toward the hour and the day, and a refused check counts nothing. With `DATABASE_URL` set every ceiling
is shared by every copy of the server. A caller is its IP address, named exactly as on the paid route.

| Ceiling | Value | Past it |
| --- | --- | --- |
| Requests per caller in any 60 seconds, cached or not, counted apart from the paid route's | 20 | 429 `{"busy": true}` |
| New checks per caller in any hour | 5 | 429 `{"busy": true}` |
| New checks running per caller | 1 | 429 `{"busy": true}` |
| New checks running on the whole service | 2 | 503 `{"busy": true}` |
| New checks started on the whole service per UTC day | 300 | 503 `{"busy": true}` |

Answers, in the order the route checks for them:

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"error": "the client address could not be read"}` | the caller's IP address is unknown, as on the paid route |
| 429 | `{"busy": true}` | this caller is past its 60 second allowance |
| 503 | `{"busy": true}` | the store could not be reached at any step before a screening; nothing was started |
| 413 or 400 | the paid route's bodies | the body is too large, not JSON, not exactly `{"wallet": "0x..."}`, or names a bad address |
| 200 | the body above with `cached: true` | the wallet's answer is in the cache |
| 202 | `{"pending": true}` | another request is screening this wallet right now |
| 429 | `{"busy": true}` | this caller is past its hour, or already has a check running |
| 503 | `{"busy": true}` | the service has two checks running, or today's 300 are used |
| 200 | the body above with `cached: false` | a new screening |

Once a screening has run its result goes out, even when the store cannot keep it in the cache.

### 4.5 Screening one wallet without a claim list

The paid route runs the replay's rulebook on one wallet with no claim list around it. With no list there is no group,
no funding burst and no shared deposit address to measure, so those facts are marked not checked instead of being
counted as doubt.

The function is `screenOneWallet(wallet: string, deps: SingleScreenDeps, signal?: AbortSignal): Promise<SingleScreen>` in
`packages/worker/src/screen/single.ts`. A caller whose own time has run out aborts the signal, which stops the screening
exactly as its 120 second limit does: no further SERV call or retry wait starts, and the answer is the time-up hold.

- `deps` is `{ facts(wallet): Promise<Facts>; decide: DecideDeps; settings: Settings }`. `liveScreen(env)` in
  `packages/api/src/live.ts` builds the real one: facts read at the latest finalized Ethereum block, then SERV in auto
  mode (the rules graph first, rulebook v2 if the graph fails), with the default settings.
- It throws `AddressError` for a bad address before reading anything or calling anyone, so a caller can refuse before
  taking payment. After that it never throws. Every failure ends in a hold with rule `A1` and one of these causes:
  "the wallet facts could not be read", "SERV gave no answer", "the screening service is out of credit", "the spend
  cap for one screening was reached", "the screening ran out of time", "the screening could not finish".
- It makes at most 12 SERV calls, and starts none after 120 seconds.

Environment, names only, read by `liveScreen` through the worker's settings check: `SERV_API_KEY`, `SERV_BASE_URL`,
`SERV_GRAPH_ID` (must name a graph Thuli has a translation for), `ETH_RPC_URL`, `BLOCKSCOUT_ETH_API`. The three URLs
must be https. It also reads the rulebook text from `packages/rulebook/thuli-rulebook.md`.

The result, `SingleScreen`:

| Field | Type |
| --- | --- |
| `wallet` | checksummed address |
| `checkedAt` | ISO 8601 date and time |
| `decision` | the worker's full `DecisionRecord` (below) |
| `servRequestId` | string or null |
| `rulebook` | `"v2"` |
| `scope` | `"one wallet on Ethereum, no claim list"` |
| `notChecked` | `["group", "sharedDepositAddress", "fundingBurst", "claimPaidToOtherAddress"]` |

`DecisionRecord` holds `wallet`, `mode` (`v3` for the graph, `v2` for the rulebook), `fallback`, `start` (`{ outcome,
rule }`), `ceiling`, `requestId`, `rawText`, `usage`, `verdict`, `modelAction`, `modelRule`, `action`, `shareBps`,
`rule`, `reason`, `citedTxs`, `clampedFrom`, `accepted`, `cause`, `secondAsk` and `firstCause`. It includes the
model's raw reply, so it must never reach a browser as it is. The paid route copies out only `action`, `shareBps`,
`rule`, `reason` and `citedTxs` (4.4), and any new screen should do the same.

What it marks as not checked: `group` (linked wallets on the same list), `sharedDepositAddress` (a deposit address
shared with other claimants), `fundingBurst` (many list wallets funded at once) and `claimPaidToOtherAddress` (no claim
has been made yet). Any other fact that could not be read still holds the wallet on `A1`.

### 4.6 Appeals

A wallet whose ask ended in a hold, an exclusion, a partial approval or a failed screening can appeal once in that
campaign. The appeal is one line of text, signed with the wallet's own key. The text is read by no model and shown on no
public page: only the operator who settles appeals sees it. Thuli sends its own decision, with everything that could
identify the wallet taken out, to an outside check (Reppo), which answers with a route (ship, review or block) and a
short note. That answer is advice. Only the project owner's call changes an outcome, and only toward an approval. Owner
sign-in is not built, so today an operator's command makes that call. The route that files an appeal is in 4.9.

Who can appeal. `addAppeal` in `packages/store/src/appeals.ts` takes the appeal only for an ask that exists and is decided
or failed, and whose action is not `full`. It keeps the action and rule the wallet appealed (`appealed_action`,
`appealed_rule`). A wallet with an appeal already in gets that appeal back. An undecided ask, or a full approval, gets no
appeal.

The message, built by `appealMessage({ campaignId, wallet, textHash, signedAt })` in `packages/core/src/appeal.ts`, is
five lines, each ending in a newline:

```text
Thuli appeal v1
Campaign: <campaignId>
Wallet: <checksummed address>
Appeal text SHA-256: <0x and 64 lowercase hex>
Signed at: <unix seconds>
```

- `campaignId` is 1 to 128 letters, digits, dots, dashes or underscores.
- The hash is `appealTextHash(text)`: SHA-256 of the UTF-8 bytes of the text exactly as stored. The browser computes it
  the same way to build the message. The server never takes a hash from the client; it rebuilds it from the text.
- The wallet signs the message as a plain personal message (EIP-191, viem `signMessage`). The signature is 65 bytes,
  `0x` and 130 hex.

The check is `checkAppeal(input, { expectedCampaignId, now, isContract })`. It returns `{ ok: true, wallet, textHash }`
or `{ ok: false, cause }` and never throws. `isContract` must answer true only for account type `contract`: a delegated
EOA keeps its own key and counts as a person's wallet. The checks stop at the first failure, in this order, each with a
fixed cause:

| Check | Cause |
| --- | --- |
| the wallet is an address | "the wallet is not a valid address" |
| the text is not empty or only spaces | "the appeal text is empty" |
| the text is at most 1000 characters | "the appeal text is longer than 1000 characters" |
| the text is plain: no `http`, `www.`, `<`, `>` or `](`, no control or invisible format characters, no broken unicode | "the appeal text contained a link, markup or control characters" |
| the text is one line: no line break, tab, other control character, or U+2028 or U+2029 | "the appeal text must be one line" |
| the campaign is the one the server expected | "this appeal is for a different campaign" |
| `signedAt` is whole seconds | "the signing time is not a whole number of seconds" |
| signed at most 600 seconds ago | "the signature is too old" |
| dated at most 60 seconds ahead | "the signature is dated in the future" |
| the signature matches the rebuilt message | "the signature does not match this appeal" |
| the wallet is not a contract | "contract wallets cannot appeal yet", or "the wallet type could not be checked" |

The signature is checked before the wallet type is read, so a request nobody signed never makes the server read a chain.
The site's form holds the text to 280 characters (`APPEAL_MAX_CHARS` in `packages/web/lib/ask.ts`); the API allows
1000 (`MAX_APPEAL_CHARS`).

Ceilings, so an appeal cannot run up the outside check's bill (C24, C49): 20 requests a minute per caller, shared with
asks; 2 signed appeals an hour per caller; 10 appeals a UTC day per campaign (`APPEALS_PER_CAMPAIGN_DAY`); and 20 a UTC
day across every campaign (`APPEALS_DAY_MAX`). The day counts are taken in the same store transaction as the appeal, so a
refused appeal costs no count. Past a day count the route answers 429 with `Retry-After` set to the seconds until the
next UTC midnight.

The outside check. The worker's appeal step (`appealNext` in `packages/worker/src/campaign/appeals.ts`) takes the oldest
ready appeal, held by a 300 second lease. A check with no evaluation id gets at most 6 counted tries
(`APPEAL_MAX_ATTEMPTS`), with the same waits as an ask (10, 30, 90 and 270 seconds, then 600). It runs once a run, after the relay step, and is skipped, with one logged
reason, when no `REPPO_API_KEY` is set; appeals then wait in the queue.

- What is sent. Only the decision: `reppoInput(record, appealedAction, reason)` in `packages/core/src/reppo.ts` builds
  the text from the stored record of the decision, written as words and counts (the wallet's age, its transactions, the
  kind of account, the kind of first funder, any group or burst), the appealed outcome and Thuli's reason, with every
  address, hash, amount and date removed. Then `identifyingPart` over the whole text looks for an address or a hash, an
  amount, a date or a time, or a number of seven digits or more. If it finds any, nothing is sent and the
  check ends unchecked. The step is never handed the appellant's text, so it cannot be sent. A decision that kept no
  record also ends unchecked.
- Sent with a bound. The check charges for every submit and cannot tell that a text was sent twice, so the worker marks
  the appeal in the store before it sends (`markAppealSubmitting`), then makes one POST with no retry inside it and a 30
  second deadline (`submitEvaluationOnce`), and stores the evaluation id at once, before any wait. A later try looks
  that id up and never submits again. A look-up waits up to 150 seconds.
- After a failed submit, `afterFailedSubmit` decides by whose fault it was, from the error's class. Out of credit (402),
  the service busy (409, 429), the key refused (401, 403) or a request that never left the machine: nothing was charged,
  the mark is taken back, the try is handed back and the appeal waits (180 seconds when busy, 600 otherwise, the
  longest wait when out of credit), for as long as it takes. A refusal of the appeal's own request (400, 404): the try
  counts. An input that can never be sent: the check ends at once. Anything else (no reply, the deadline, 408, a 5xx, a
  reply out of shape) is unclear: the mark stays, and the next take counts it in the store (`countUnclearSubmit`). At
  `MAX_UNCLEAR_SUBMITS`, 2, the check ends with "the outside check may already have been paid for"; below it the
  worker submits once more. So one check is paid for at most twice.
- A paid check is followed. Once an evaluation id is stored, no count of tries ends the check: an unfinished look-up
  waits 300 seconds with its try handed back, the store ends it a day after its submit, and an evaluation the outside
  check reports as failed ends it at once.
- What is stored. The route (`ship`, `review` or `block`; none when Reppo named one Thuli does not know, and the check
  still counts as checked because it was charged), a note cut to 280 characters and kept only if it is plain text, the
  evaluation id and the credits charged. Reppo's score (0 to 100), its decision word and its confidence are kept too, for
  the operator's list only.
- The public view of an appeal has exactly these fields: `filedAt`, `checkStatus` (`queued`, `checking`, `checked` or
  `unchecked`), `reppoRoute`, `reppoNote`, `reppoEvalId`, `checkedAt`, `outcome` (`open`, `reversed` or `upheld`),
  `newAction` and `settledAt`. There is no field for the text, its hash, the signature, the owner's note, the score, the
  decision word, the confidence or the check's cause.

Bound to the decision. An appeal is about the action and rule it was filed against. If the ask no longer has them, the
check ends unchecked with the cause "the decision changed after the appeal", unless the change is the owner's own
reversal or the check already holds an evaluation id: those are still checked. A failed ask that has an appeal is never
put back in the queue by `campaign:requeue`, so the appeal and the check always judge the decision that was appealed.

The owner's call. The operator runs `npm run appeal:settle -- --id CAMPAIGN --wallet ADDRESS --outcome reversed|upheld
[--action full|partial] [--note "..."] [--write]` (`packages/worker/scripts/appeal-settle.ts`). Without `--write` it
prints the appeal and the store's own answer, written nowhere. The outside check is not read.

- `reversed` needs `--action full` or `partial`, more generous than the appealed action, and an ask that still holds the
  appealed action. The ask becomes that approval with the share the campaign's terms give it. An ask with no slot takes
  the next free slot number while the campaign has fewer slot holders than slots; a partial raised to full keeps its slot.
  A failed ask becomes decided. The next list the worker posts carries the wallet like any slot holder.
- `upheld` takes no action and changes nothing but the appeal.
- A settled appeal is final. The store refuses to settle twice, a reversal that is not more generous, and an ask that
  changed after the appeal was filed, each with a fixed cause.

Other operator commands. `npm run appeal:list -- --id CAMPAIGN` prints one block for each appeal: the wallet, the ask's
action and rule, the appeal's text, the outside check and the outcome. It is the only place the text is shown. Text from
outside Thuli (the appellant's, the owner's and Reppo's) is printed as one quoted string after a fixed label, so it
cannot pass for a line of the command's own (C58). `npm run appeal:export -- --id CAMPAIGN [--file PATH] [--write]`
appends each checked appeal not yet in the file, with Reppo's whole verdict and the decision as it was appealed, to a
private file that git ignores, as input for the next rulebook change. A line holds no appeal text, hash, signature or
owner note. A file holding any line that is not an exported appeal is refused and left as it was.

Not built yet:

- No owner sign-in, so no real session can supply the owner's confirmation. An operator's command settles appeals.
- The scorecard does not score appeals. The export is input for the next rulebook change and nothing reads it yet.
- Two Reppo evaluations have been made for appeals, both on 13 Nov 2026 and both against one test wallet's partial
  decision (`cmwegxukf000508l98c92l3va`: route `review`, on a local run; `cmwezv7mt000007lbw9ii5xzp`: route `ship`, on the hosted demo
  campaign; 440 credits each, charged once, the owner upheld both). The route `block`, a reversal and the failure
  paths have run only in tests, against a stand-in for Reppo.
- Contract wallets cannot appeal, nor can a wallet whose type could not be read.
- A reversal changes the ask and its slot, not the vault. The wallet is paid only after the worker posts a new list and
  the vault's delay passes.

An earlier offline demo, `npm run appeal:demo`, keeps appeals in a local file and asks SERV for advice. The campaign path
does not use it: it keeps appeals in Postgres and sends the appellant's words to no model.

### 4.7 Replay files for the landing page

`npm run export:replay` writes these static files from the stored replay, under `packages/web/public/replay/`:

- `robo/summary.json`: every headline number, the run date, the rulebook version, the SHA-256 of the two input files,
  and one entry per linked group.
- `robo/points.json`: one entry per claim wallet, in claim-list order: outcome code 0 full, 1 partial, 2 hold,
  3 exclude; group index or -1; whole ROBO claimed; funding-burst flag. It holds no wallet address.
- `robo/wallets/00.json` to `robo/wallets/ff.json`: one entry per claim wallet, keyed by lowercase address and filed
  under the address's first two hex characters. Each entry holds the outcome, the share, the rule, the reason as plain
  text, the cited transactions, the facts behind the decision and the SERV run id.
- `robo/groups/<index>.json`: one linked family, with every member wallet in claim-list order.
- `versions.json`: the scorecard of rulebook v1 against v2, both scored on the same stored model replies.
- `hop.json`: the Hop control numbers, how often the code holds Hop's probably-real wallets and its eliminated ones,
  as counts and 95% intervals only.

The replay shows what the current rulebook decides: each stored model reply is checked again with today's checks, and
no model is called. `summary.json` names that version in `run.rulebook`. No file holds a raw model reply.

### 4.8 Not built yet

Sections 1 to 3 draw the whole system. On 11 Nov 2026 the code does not have the parts below; each was checked by
searching the code.

- Postgres for general jobs. `packages/store` (Postgres through `pg`) has tables for payment claims, leases, rate
  events, day counts, the check cache, and the live campaign's terms, asks, list versions, claim relays and appeals
  (4.9). The paid, free and campaign routes and the worker use it, shared by every server copy when `DATABASE_URL` is
  set. General jobs have no tables.
- The web app's own routes for owner sign-in and owner campaign management. The site serves `/api/x402/*`,
  `/api/check*` and the public campaign routes `/api/campaigns/*`, which take asks and appeals (4.9), through
  `packages/web/lib/server/thuliApi.ts`; its only other route handler is the docs search at `/api/search`. No route
  creates a campaign, posts a list or settles an appeal. A project can connect its wallet on the web app's
  `/campaign/start` page to create and fund a vault on Base Sepolia; the campaign is then registered by an operator with
  `npm run campaign:create`, the worker posts its lists (4.10), and an operator settles its appeals (4.6).
- A general job queue. Only campaign asks, claim relays and appeal checks are queued, each in its own table (4.9); the
  paid route screens inside the request, and the replays run as scripts.
- Paid data through Kite Passport, and the Nansen and Allium lookups behind it. No code calls Kite, Nansen or Allium.
- Dolphin summaries. There is no Dolphin client.
- Worker hosting as code. The worker runs as one process on Railway, set up by hand in the host's own settings (start
  command, restart policy, variables). The repository holds no container file and no host configuration.
- A campaign on Base mainnet. The factory is deployed there and one proof vault paid 1 real USDC (4.1). That is one
  vault, one list and one wallet; the campaign is on Base Sepolia. The paid route has settled one real payment on
  Base mainnet (0xd55cd1ba2f1fcbc639a0d5d54ecf60fc9492226232f952da2d8af87bfcba47d4, 13 Nov 2026), in a run on one machine.
- Owner sign-in for appeals. Appeals are filed through the public route, checked by the outside check and settled by an
  operator's command (4.6). No owner can sign in to settle one, the scorecard does not score appeals, and no Reppo
  evaluation has been run for one yet.

### 4.9 Campaign routes

One open campaign, public from the start, where any wallet may ask for a reward. A wallet signs an ask, the worker
screens it later, an approved wallet takes one of the campaign's paid slots, and once its list is active on the vault
the wallet can read its claim ticket. A wallet that was not approved in full can appeal (4.6). The routes are
`registerCampaignRoutes` in `packages/api/src/campaigns.ts`, served by the site at `/api/campaigns/*`. Nothing is screened
and no outside check is made inside a request.

Rules every route keeps:

- The campaign is looked up before anything else in the request is read, so an unknown id always answers 404
  `{"error": "no such campaign"}`, whatever the path, body or query hold.
- A database that cannot be reached answers 503 `{"busy": true}`, and nothing is written.
- Every answer passes a strict shape in `packages/api/src/schema.ts` before it leaves and carries
  `cache-control: no-store`. No answer holds a signature, a lease, an attempt count, an appeal's text or a caller's
  address.
- Every limit counts on the caller's address as the paid route reads it, never on anything the caller writes. A limit
  that cannot be read refuses the request.
- Amounts are base units as decimal text. Times are ISO 8601. Show every `reason` and `reppoNote` as text only.

| Route | Answer |
| --- | --- |
| `GET /api/campaigns/:id` | 200 with the campaign below |
| `GET /api/campaigns/:id/board?before=<ISO time>` | 200 `{"asks": [...], "payouts": [...]}`. `asks`: 50 decided or failed asks, newest decision first, plus every further ask decided at the same instant as the 50th (at most 100 more), decided strictly before `before` when it is given. `payouts`: for each wallet on the page with a confirmed claim relay, `{wallet, amount, transaction}`, the newest confirmed relay's cumulative amount and its claim (`confirmedPayouts` in the store); a wallet that claimed with its own ticket has no relay and no entry. A page never ends inside a tie, so walking the board with `before` set to the last ask's `decidedAt` skips no ask; 400 for a time that is not ISO 8601 |
| `POST /api/campaigns/:id/asks` | the ask answers below |
| `POST /api/campaigns/:id/appeals` | the appeal answers below |
| `GET /api/campaigns/:id/asks/:wallet` | 200 `{"ask": ..., "ticket": ...}`, with `ticket` only for a wallet on the active list; 400 `{"error": "the wallet is not a valid address"}`; 404 `{"error": "no ask from this wallet"}` |
| `GET /api/campaigns/:id/lists/:version` | 200 with the list's published text exactly as stored, as `application/json`, so anyone can rebuild its root; 404 `{"error": "no such list version"}` |

The four GET routes share one allowance of 120 requests a minute per caller, counted first: past it, 429
`{"busy": true}`.

The campaign:

| Field | Type |
| --- | --- |
| `name` | plain text, 1 to 80 characters |
| `chain` | the vault's chain id, 84532 for Base Sepolia |
| `vault`, `token` | checksummed addresses |
| `rewardPerWallet`, `perWalletCap` | decimal text, base units |
| `maxSlots` | how many wallets can be paid, 1 to 100,000 |
| `status` | `"open"` or `"closed"` |
| `opensAt`, `closesAt` | ISO 8601; asks are taken from `opensAt` up to, not including, `closesAt` |
| `counts` | `asked`, `queued` (screening included), `decided` (failed included), `held` (failed included), `slotsTaken`, `slotsLeft`, `asksLeft` (how many more asks the campaign takes before its lifetime cap) and `appeals` (`filed`, `checked`, `block` for those the outside check routed to block, `reversed` for those the owner reversed) |
| `lists` | one entry per list version, oldest first: `version`, `root`, `status`, `claimableAt` (Unix seconds, null until posted) and `postTx` |

A list's `status` is one of:

| Status | Meaning |
| --- | --- |
| `built` | The list is recorded and its root has not been signed. `postTx` is null. |
| `sending` | The worker has signed the post, recorded its hash and nonce, and may have sent it. `postTx` is set. Whether the root reached the vault is not known yet, and the worker settles it from the receipt (4.10). `claimableAt` is null. |
| `posted` | The root is pending on the vault, or paid, with the vault's own claimable time. |
| `active` | The vault pays this root now. |
| `superseded` | A newer list is active. |
| `cancelled` | The list never became active: the owner cancelled it on the vault, or it was out of date before it was posted. |

`postTx` is null for a list not yet sent, and for a root the worker found pending on the vault with no record of sending
it. The post's nonce is private and no route returns it.

One ask, as `ask` in the answers above and as each entry of the board:

| Field | Type |
| --- | --- |
| `campaignId`, `wallet` | the campaign id and the checksummed wallet |
| `askedAt` | ISO 8601 |
| `status` | `"queued"`, `"screening"`, `"decided"` or `"failed"` |
| `action`, `shareBps`, `rule`, `reason`, `citedTxs`, `notChecked`, `decidedAt` | the decision as in the paid reply (4.4), null until the ask is decided or failed |
| `facts` | the public chain facts the decision rested on, null unless decided: `ageDays`, `txCount`, `accountType`, `funder` (`address`, `kind`, `fanout`, `hops`, or null), `burstWallets`, `groupSize`, `missing` |
| `servRequestId` | SERV's run id or null |
| `slot` | the wallet's paid slot, 1 up to `maxSlots`, or null |
| `appeal` | the wallet's appeal in its public view below, or null when it filed none |

A failed ask is one whose screening could not finish after its attempts: it reads action `hold`, rule `A1` and the
reason "Held for review: the screening could not finish." A wallet that had never been used on Ethereum or Base when the
worker looked at it is held by code under `A1`, with the reason "A1: This wallet has never been used on Ethereum or
Base, so there is nothing to screen." and no model call. A worker whose Base history is off decides no such wallet:
its tries fail and the ask ends held for review. Held and excluded wallets never take a slot, and slots go in the order asks are
decided. A reversed appeal can give an ask a slot later (4.6).

One appeal, as `appeal` on an ask and in the appeals answers:

| Field | Type |
| --- | --- |
| `filedAt` | ISO 8601 |
| `checkStatus` | `"queued"`, `"checking"`, `"checked"` or `"unchecked"` (the outside check could not be made, or was not allowed to be) |
| `reppoRoute` | `"ship"`, `"review"` or `"block"` from the outside check, or null |
| `reppoNote` | the outside check's short note, plain text of at most 280 characters, or null. A note holding a link or markup leaves as null |
| `reppoEvalId` | the check's evaluation id, 1 to 64 letters, digits, dashes or underscores, or null |
| `checkedAt` | ISO 8601, or null |
| `outcome` | `"open"`, `"reversed"` or `"upheld"`, the owner's call |
| `newAction` | `"full"` or `"partial"` when reversed, otherwise null |
| `settledAt` | ISO 8601, or null |

The ticket, built by `claimTicket` from the active version's published text and refused unless it rebuilds that
version's recorded root:

| Field | Type |
| --- | --- |
| `cumulativeAmount` | decimal text, the amount in the wallet's leaf |
| `proof` | the Merkle proof, `0x` and 64 lowercase hex each |
| `root` | the active root it proves against |
| `claimed`, `claimable` | decimal text read from the vault, left out when the vault's chain has no reader, the read fails, or the read routes have caused 600 chain reads in the last minute across every caller and server copy |

The wallet, or anyone for it, then calls `claim(account, cumulativeAmount, proof)` on the vault (4.2). A failed read of
the vault leaves `claimed` and `claimable` out. It is never shown as zero.

Asking. The wallet signs the text `askMessage({ campaignId, wallet, signedAt })` in `packages/core/src/ask.ts` builds,
four lines, each ending in a newline, as a plain personal message (EIP-191):

```text
Thuli ask v1
Campaign: <campaignId>
Wallet: <checksummed address>
Signed at: <unix seconds>
```

The body is exactly `{"wallet": "0x...", "signedAt": <unix seconds>, "signature": "0x..."}`, at most 1 KB. The campaign
comes from the path, never the body. The two POST routes share one allowance of 20 requests a minute per caller, counted
after the size check and before the body is read, so a malformed body counts too. The answers, in the order the route
checks for them:

| Status | Body | When |
| --- | --- | --- |
| 404 | `{"error": "no such campaign"}` | no campaign has this id |
| 413 | `{"error": "the body is too large"}` | the body is over 1 KB |
| 400 | `{"error": "the client address could not be read"}` | the caller's IP address is unknown |
| 429 | `{"busy": true}` | more than 20 requests from this caller, asks and appeals together, in 60 seconds |
| 400 | `{"error": "..."}` | the body is not JSON, or not exactly the three fields |
| 400 | `{"error": "<cause>"}` | the ask failed its check, with one of the causes below. The signature is checked before any chain is read |
| 503 | `{"busy": true}` | the wallet-type reads of every caller and both POST routes have reached 600 in a minute, or could not be counted; nothing was read |
| 429 | `{"busy": true}` | more than 5 asks that passed the check from this caller in an hour |
| 200 | `{"exists": true, "ask": ...}` | this wallet already asked, in any spelling; the first ask stands unchanged, and no door read is made |
| 503 | `{"busy": true}` | the door reads of every caller have reached 300 a minute (150 asks), or a door read failed, timed out or did not answer a whole number |
| 200 | `{"neverUsed": true}` | the wallet has sent no transaction and holds no balance on Ethereum, and none on Base mainnet. Nothing was stored, queued or counted |
| 202 | `{"queued": true}` | the ask is stored and waits for screening |
| 409 | `{"closed": true}` | the campaign is closed, or now is outside `opensAt` to `closesAt` |
| 409 | `{"full": true}` | the campaign cannot seat another wallet: every slot is taken, 200 asks already wait undecided, or its asks have reached the lifetime cap |
| 503 | `{"busy": true}` | the database could not be reached; nothing was written |

The check is `checkAsk` in `packages/core/src/ask.ts`. It stops at the first failure, in this order: "the wallet is not a
valid address", "this ask is for a different campaign", "the signing time is not a whole number of seconds", "the
signature is too old" (signed more than 600 seconds ago), "the signature is dated in the future" (more than 60 seconds
ahead), "the signature does not match this ask", "contract wallets cannot ask yet" (contract code on Ethereum or on the
campaign's own chain), "the wallet type could not be checked". A signature made over an appeal, or over another
campaign's ask, fails the signature check. The wallet type is read last, so a request nobody signed makes no chain read.

The door rule. A wallet that has never been used on Ethereum or on Base cost its sender nothing to make, so it is not an
ask. After the check and the earlier-ask lookup, the route reads the wallet's sent-transaction count and its balance on
Ethereum at the latest finalized block, the block the worker screens at. A wallet with either above zero goes on, and
Base is not read. A wallet empty on Ethereum is read the same way on Base mainnet (`neverUsedOnBothChains`), on
BASE_RPC_URL or else Base's public endpoint, and those two reads are counted against the same ceiling before they are
made. Empty on both is answered `{"neverUsed": true}` with nothing stored, queued or counted: no slot, no cap and no
screening are spent on it. A read that fails, times out or is not a whole number answers busy, never "used"
and never "never used". The door reads have a ceiling of their own, 300 a minute across every caller and server copy,
and each pair follows a signed ask that spent one of its caller's 5 an hour.

`full`. The store (`addAsk` in `packages/store/src/campaigns.ts`) turns an ask away when every slot is taken
(`slotsLeft` is 0), when `ASK_BACKLOG_CAP`, 200, asks wait undecided (queued or screening; room returns as they are
decided, and held history does not count), or when the campaign has taken `askLifetimeCap`, the larger of 1,000 and 100
for each slot. A wallet that asked before always gets its ask back first. There is no daily ceiling on accepted asks. The
worker bounds the model spend instead, at 2,000 screenings a UTC day (4.10).

Appealing. A wallet whose ask was not approved in full signs the text of 4.6 and posts it with the body exactly
`{"wallet": "0x...", "text": "...", "signedAt": <unix seconds>, "signature": "0x..."}`, at most 2 KB. The text hash is
rebuilt from the text and never taken from the caller. The answers, in the order the route checks for them:

| Status | Body | When |
| --- | --- | --- |
| 404 | `{"error": "no such campaign"}` | no campaign has this id |
| 413 | `{"error": "the body is too large"}` | the body is over 2 KB |
| 400 | `{"error": "the client address could not be read"}` | the caller's IP address is unknown |
| 429 | `{"busy": true}` | more than 20 requests from this caller, asks and appeals together, in 60 seconds |
| 400 | `{"error": "..."}` | the body is not JSON, or not exactly the four fields |
| 400 | `{"error": "<cause>"}` | the appeal failed its check (4.6). The text must be one line, and the signature is checked before any chain is read |
| 503 | `{"busy": true}` | the shared wallet-type read ceiling is reached, or could not be counted; nothing was read |
| 429 | `{"busy": true}` | more than 2 signed appeals from this caller in an hour |
| 202 | `{"queued": true}` | the appeal is stored and waits for its outside check |
| 200 | `{"exists": true, "appeal": ...}` | this wallet already appealed; the first appeal stands unchanged |
| 409 | `{"undecided": true}` | the ask is not decided or failed yet |
| 409 | `{"approved": true}` | the ask is a full approval |
| 404 | `{"error": "no ask from this wallet"}` | this wallet never asked |
| 429 | `{"busy": true}` with `Retry-After` set to the seconds until the next UTC midnight | the campaign's 10 appeals for the day, or the 20 across every campaign, are used |
| 503 | `{"busy": true}` | the database could not be reached; nothing was written |

No answer and no log line carries an appeal's text, its hash, its signature or the owner's note.

Readers. The wallet type is read from its code on `ETH_RPC_URL` and on the campaign's own chain (once for a campaign on
Ethereum), by the facts' rule: a delegated EOA (EIP-7702) keeps its own key and counts as a wallet. Code on either chain
refuses the ask as a contract wallet. A failed read, or a campaign chain with no reader (Base with `BASE_RPC_URL` unset,
or any chain but Base and Base Sepolia), refuses it with "the wallet type could not be checked". Every read gives up after
10 seconds, with one retry. Vault amounts are read on Base Sepolia's public RPC for chain 84532, and for Base (8453) on
`BASE_RPC_URL` when it is set; a `BASE_RPC_URL` that is set but not https stops the API from mounting. A campaign on any
other chain gets tickets without `claimed` and `claimable`.

Two small caches live in each server copy and nothing in them is served for another campaign, version, vault or wallet
than it was read for. One holds the last 8 active lists used, parsed with their trees. The other holds a wallet's
`claimed` and `claimable` for 15 seconds, at most 5,000 entries.

Storage, in `packages/store/src/campaigns.ts` and `packages/store/src/appeals.ts` (migrations `002_campaigns.sql` to
`010_appeal_submit_mark.sql`): `campaigns` holds the terms, among them `settings`, only the screening settings this
campaign changes from the defaults, checked by core's `Settings` schema, and `vault_block`, the block the vault was
created in; `asks` holds one row per wallet, its signature kept as the proof it asked and returned by no route, and for a
decided ask a private `record` of what the decision rested on, kept so an appeal can be checked later; `list_versions`
holds each list exactly as published, with the post's hash and nonce; `claim_relays` holds the claims the worker submits
for wallets, at most 10 attempts each; `appeals` holds one row per ask, its text, hash, signature, owner note and the
outside check's score, decision word and confidence kept private. An ask, a relay or an appeal whose try failed waits out
the retry time the worker sets before it is handed out again, so an outage cannot use up every attempt in seconds.
Campaigns are created with `createCampaign`, which refuses different terms for an existing id.

### 4.10 The campaign worker

The campaign worker does the work no web request does. It screens each ask, posts the list of approved wallets to the
campaign's vault, submits each wallet's claim from its own key once the vault's delay is over, so the wallet is paid
without paying gas, and sends each appealed decision to the outside check. It is a script, `npm run worker`
(`packages/worker/scripts/worker.ts`), and its code is in `packages/worker/src/campaign/`. It runs as one process on a
host, Railway, against Base Sepolia with test money. The host starts it with `node --import tsx
packages/worker/scripts/worker.ts`, node itself and not npm, so the host's stop signal reaches the worker and it finishes
the step under way; the restart policy is always, and one copy is the design. It shares Postgres, hosted at Neon, with
the routes in 4.9: the routes put asks and appeals in, and the worker takes them out. The site answers anonymous
traffic, so it reads chains through public RPC addresses only; the worker alone holds the keyed RPC endpoints the
two-chain read needs.

A lease, used below, is a note on a row saying one worker holds it until a set time. If that worker stops, the row is
free again when the time passes.

#### What one run does

A run goes through the steps below in order. The loop starts the next run 5 seconds after a run ends (`LOOP_INTERVAL_MS`
in `loop.ts`). Each step has a time limit (`STEP_TIMEOUTS_MS`). A step that fails or runs out of time is logged and the
run goes on to the next step; whatever the step held is tried again when its lease runs out. A step that fails the same
way on every run is logged once, again only when its cause changes, and a line says when it works again.

| Step | What it does | Limit |
| --- | --- | --- |
| 1. Screen one ask | Takes the oldest ready ask of any campaign, leased for 300 seconds, screens it as described below, and stores the decision. | 180 seconds |
| 2. Read the open campaigns | Every campaign whose status is `open`, in id order, at most 100 (`MAX_OPEN_CAMPAIGNS`). | 30 seconds |
| 3a. Reconcile, for each campaign | Brings the list records in line with what the vault shows (below). Sends nothing. | 120 seconds |
| 3b. Activate, for each campaign | Marks a posted list active once the vault's own clock has reached its claimable time and the vault pays its root, then queues one relay for each listed wallet the vault still owes. | 120 seconds |
| 3c. Publish, for each campaign | Posts the slot holders' list to the vault when that list is not on chain yet. | 300 seconds |
| 4. Relay one claim | Takes the oldest ready relay and submits that wallet's claim. | 300 seconds |
| 5. Check one appeal | Takes the oldest ready appeal and sends Thuli's decision to the outside check (4.6). Skipped, with one logged reason, when no `REPPO_API_KEY` is set. | 240 seconds |

- Reconcile runs first, so a list that was posted but never recorded is recorded before anything is built on it.
  Activate runs before publish, so a list whose delay has just ended is marked active before the next list is posted
  over it. If reconcile fails or runs out of time, activate and publish do not run for that campaign in that run. A
  campaign whose row records no `vault_block` is skipped, and the reason is logged once.
- A wallet is queued for a relay only when the vault says it is still owed something: the wallet's listed amount less
  `claimed(wallet)`, read at the block the roots were read at. A wallet paid in full, under this list or an earlier one,
  gets none; a wallet paid in part is relayed for the rest. Relays are queued once for each list version in a process.
  After a restart they are queued again and nothing is added, because a relay already queued is left as it is.
- A zero from the vault is never taken to mean "paid". A paused vault answers 0 to every `claimable()` and refuses every
  claim, so the worker reads the vault's paused flag with the roots. While the vault is paused, activate marks and
  queues nothing and says so once, and a relay already waiting is given back with the longest wait, 600 seconds, and its
  try handed back, so a pause of any length uses up none of its tries. After the unpause exactly the owed wallets are
  queued. The same holds when a claim's simulation reverts with the pause error a lagging read missed.
- Each limit is above the limits inside its step. A screening stops itself at 120 seconds and makes at most 12 SERV
  calls. A post or a claim waits at most 180 seconds for its receipt. A Base Sepolia call times out at 30 seconds and
  an Ethereum read at 15. An appeal's look-up waits at most 150 seconds inside its 300 second lease.
- A step that ran out of time does nothing more. At its limit the loop aborts the step's signal, and every step checks it
  before each store write, each signature and each send, so a stopped step writes and sends nothing after its limit
  (C52). Two records are kept even then, because dropping them would hide a real send: a claim already on the network is
  recorded as sent with its hash, and an evaluation id the outside check returned is stored. What the step held stays
  leased until the lease runs out.
- `SIGINT` or `SIGTERM` lets the step under way finish and then stops the loop. A second signal stops the process at
  once. `npm run worker -- --once` makes one run of every step and exits.
- The worker serves every campaign whose status is `open`, whatever its opening and closing times, because it keeps
  posting lists and paying claims after the asks close. No command in this repository sets a campaign's status to
  `closed`.

#### How an ask is screened

`screenNextAsk` in `screen.ts`, in order:

1. The campaign is looked up. A missing campaign, a campaign on a rulebook other than the current one, or settings that
   are not valid stop the screening, and the ask goes back to the queue (see "What happens on failure").
2. The wallet's own facts are read on one chain at its latest finalized block: its age, its transactions sent, its
   account type and its first funder, the address that sent it its first real money. They are taken into single-wallet
   scope, as in the paid route (4.5). Which chain: when both RPC endpoints passed the start probe (`screenChains` in
   `packages/worker/src/campaign/chain.ts`: the chain id, old state, `trace_filter` and `trace_transaction`),
   `pickChain` reads the wallet's first activity on Ethereum and on Base mainnet, by core's `firstActivityTime`, and
   `olderChain` names the chain where it is older (one chain only: that one; a tie: Ethereum). A chain whose first used
   block was found but could not be read gives that block's time as a lower bound, and the other chain is picked only
   when it is older than the bound, or as old when that other chain is Ethereum, where a tie goes. The facts are then read on that chain at the block the picker read it at, with
   plain RPC calls and no explorer (`rpcHistory` in `packages/worker/src/facts/rpcHistory.ts`): a halving search for
   the first block where the sent count or the balance is above zero, every block that paid the wallet until its first
   own transaction that succeeded, and those blocks' transfers from their traces, which must add up to each block's
   rise in the balance for every block in which the wallet itself sent nothing. The funder's kind is read on the same chain. The chain is stored in the ask's public facts as
   `chain` (`ethereum` or `base`). If either chain cannot be read, or any read of the facts fails, the try fails and
   is taken again: a failed read is never stored as a hold. About 220 RPC calls an ask, and at most 1,000
   (`MAX_READ_CALLS`) for each of its three history reads; the reads of a try stop when the try ends.
   At start, an endpoint that answers and serves no old state or no traces turns the two-chain read off: one log line
   says which endpoint lacks what. The worker then asks Base, with two plain calls, whether the wallet was used there. A
   wallet used on Base is not decided ("the wallet was used on Base, and Base history is off"); only a wallet not used
   there is read on Ethereum through the explorer reader. An endpoint that gives no answer to a plain read, a rate
   limit or a server fault included, is asked again after 2, 5, 15 and 30 seconds, and if it stays silent, or names
   another chain's id, the worker does not start. An endpoint that answers plain reads and leaves its trace calls
   unanswered on two of its probes is read as serving no traces. The free public Ethereum endpoint in `.env.example`
   does that, and the public Base one refuses trace calls outright. `npm run campaign:screen` runs this path for any wallet and stores nothing.
3. The first funder's kind is read from the chain. The facts reader leaves it unknown, so the worker reads the funder's
   code and its count of transactions sent at a finalized block, when the ask is screened, and applies core's
   `funderKind`: contract code makes it a `contract`, a plain address with 10,000 or more transactions sent
   (`HIGH_VOLUME_NONCE`) is an `exchange`, and any other is a `wallet`. A wallet delegated by EIP-7702 keeps its own key
   and counts as a wallet. If the funder cannot be read, the screening stops and the ask is tried again: it is never
   linked or cleared on a guess. The replay classifies its funding roots with the same function.
4. The family is built from the campaign's own asks (below), and the code sets the start and the ceiling from the facts
   and the campaign's settings (checks A1 to A9).
5. A wallet that was never used is decided by code. If its own facts show no transaction sent, a plain account, no first
   funder in a history that was read, and an age that is known, and its start and ceiling are both a hold under `A1`, the
   decision is that hold with the reason "A1: This wallet has never been used on Ethereum or Base, so there is nothing to
   screen." and no model call, on its first try. Only a worker that read both chains' histories decides this. The model could only have written the reason. A read that failed leaves a fact
   unknown, so a failed read is never taken for an empty wallet.
6. Every other screening first takes one count of the day's budget: 2,000 model screenings a UTC day across every
   campaign (`CAMPAIGN_SCREENINGS_DAY_MAX`), counted in one store statement right before SERV is called, so two workers
   cannot pass it together. When the day is used up, the ask is given back with its try handed back and waits until just
   after the next UTC midnight, said once in the log. When the count cannot be read, the ask is given back like a failed
   try and no screening runs (C49).
7. SERV is asked (the rules graph first, the written rulebook if the graph fails), then the output checks run. This is
   `decideWallet` in auto mode, the same path as every other screening (4.5), and the decision is never above the
   ceiling.
8. An answer the output checks refuse becomes a hold on rule `A1`. On an ask's first two tries (`REFUSED_ANSWER_TRIES`
   is 3) it is given back like a failed try with the usual wait instead of being stored, because on the replay 6 of 8
   sampled holds of this kind did not come back when the same wallet was asked again. From the third try on the hold is
   stored. The retry takes the same ceiling and the same checks, so it can never approve what they would not.
9. `decideAsk` stores the decision, the reason, the cited transactions in lowercase, the public facts it rested on, the
   SERV run id and the list of facts not checked. It also keeps, privately, the flat record of what the model was given,
   or would have been given for a decision made by code, so an appeal can be checked later. An approved ask (`full` or
   `partial`) takes the next slot number while the campaign has slots left. A held or excluded ask never takes one.

The family. Two asking wallets are joined when they share a first funder of kind `wallet`. An exchange or a contract
joins nobody. A funder that also asked is in the family of the wallets it paid, and a chain in which each wallet funded
the next is one family. A decided ask counts as a member, a held one too. An ask still waiting, or one whose screening
failed, has no funder record, so it counts only when it is itself the first funder of a wallet in the family. The family
size counts the wallet itself, and a group exists from two wallets up. The fan-out of the wallet's first funder is the
number of asking wallets it paid, this one included, or none when that funder is an exchange or a contract. Then the
usual rules decide: A4 holds a family of `groupMinSize` wallets or more, and A5 holds a funder that paid
`funderFanoutMin` wallets or more. The defaults are 5 and 10 (`packages/core/src/settings.ts`), unless the campaign's
row changes them. A campaign ask is never excluded for its family: exclusion under A3 needs sweep evidence, which a
campaign cannot see, so a family can hold a wallet but not exclude it (C15).

Every decision the worker stores carries the facts it could not measure (`CAMPAIGN_NOT_CHECKED` in `facts.ts`):

| Not checked | Why |
| --- | --- |
| `sharedDepositAddress`, `sweptToSharedCollector` | They need every asking wallet's sends. |
| `fundingBurst` | It needs every asking wallet's funding amounts and times. |
| `claimPaidToOtherAddress` | No claim has been paid yet to be redirected. |
| `passThroughFunding` | The first funder is the wallet's direct one. A funding that reached it through pass-through wallets is linked by the last hop only. |

#### What happens on failure

The wait after a failed try is `retryDelaySeconds` in `screen.ts`. Asks, relays and appeals use the same one.

| Try that just failed | Wait before the next try |
| --- | --- |
| 1st | 10 seconds |
| 2nd | 30 seconds |
| 3rd | 90 seconds |
| 4th | 270 seconds |
| 5th and every later one | 600 seconds |

An item waiting out its time never holds back the ones behind it. The store refuses any wait above 86,400 seconds
(`MAX_RETRY_SECONDS`).

| | Ask | Relay | Appeal's outside check |
| --- | --- | --- | --- |
| Tries | 10 (`MAX_ASK_ATTEMPTS`) | 10 (`MAX_RELAY_ATTEMPTS`) | 6 (`APPEAL_MAX_ATTEMPTS`) |
| Waits before it is given up | Nine, 3,400 seconds in all, so an outage of up to about 57 minutes is waited out | The same | Five, 1,000 seconds in all |
| Lease | 300 seconds (`ASK_LEASE_SECONDS`) | 300 seconds (`RELAY_LEASE_SECONDS`) | 300 seconds (`APPEAL_LEASE_SECONDS`) |
| What a failed try is | Facts that could not be read, SERV with no answer or out of credit, the call cap of 12, the 120 second limit, a campaign that is missing or on another rulebook, settings that are not valid, funder records that could not be read, a family with more than 1,000 funders to look up, a refused answer on one of its first two tries, or a decision the store refused | A claim that would revert for any reason but `NothingToClaim` and the pause error, a claim that reverts on chain, a failed call, or a campaign on another chain than the worker | An evaluation not finished, a failed evaluation, or a failed call |
| Tries handed back, not counted | The day's budget is used up | The vault is paused | Out of credit at the outside check |
| Ends as | Status `failed`: a hold on rule A1, share 0, the reason "Held for review: the screening could not finish.", no facts, never a slot | Status `failed` | Check status `unchecked`; the appeal can still be settled |

A relay also ends `failed` at once, with no retry, when the list version has no published text or the wallet is not on
that version with the amount queued. A claim that the vault answers `NothingToClaim` is marked `confirmed` without a
transaction, because the vault has already paid the wallet everything it is owed. A broadcast claim is marked `sent`
with its hash before the receipt wait, so a worker that stops mid-wait leaves a record, and the next try finds
`NothingToClaim` if the claim landed.

A wallet whose relay failed is still owed its reward. Once its list is active it can read its claim ticket from
`GET /api/campaigns/:id/asks/:wallet` (4.9) and call `claim` itself, paying its own gas.

A hold caused by an outage can be screened again by an operator: `npm run campaign:requeue` (below) puts a failed ask back
in the queue from the start. A decided ask, a decided hold included, is never moved by it, and neither is a failed ask
that has an appeal (C55).

#### Sending a list, and settling it

The worker records its own chain write before the network can know it, sends it at most once for each nonce, and calls it
dead only on proof (C51). `publishCheck` in `publish.ts` sends a list through `recordedPort`:

1. Right before signing, it reads the vault and the store again. It refuses when the vault now has a pending root, or when
   this version is no longer the newest built one, so a step that stalled cannot post over a newer list.
2. It simulates `postRoot` from the agent, signs it, and records the hash and the nonce with the version, which becomes
   `sending`, before anything is broadcast.
3. It broadcasts the signed bytes and waits up to 180 seconds for the receipt. Mined and successful: the version is
   `posted` with the claimable time the receipt's own `RootPosted` log holds. Mined and reverted: the version is `built`
   again. Not mined in time: it stays `sending` and reconcile settles it.

While any version of a campaign is `sending`, nothing more is posted for it. Reconcile settles a `sending` version on
proof only (`settleSending`), in this order:

| Rule | What the worker finds | What it does |
| --- | --- | --- |
| a | A receipt for any transaction it was sent with: the stored one, or an earlier one this process signed at the same nonce. | Mined and successful: posted, with that receipt's claimable time. Mined and reverted: built again. |
| b | No receipt, and the agent's mined nonce is above the stored nonce, so another transaction used it. | The vault is read at once. A root pending or paid there landed, and is recorded posted. Otherwise "nonce used, no receipt, root not on the vault" must hold on every read for 120 seconds (`CANCEL_MARGIN_SECONDS`), any sighting of the post starting the count again, before the version is built again and signed anew at a fresh nonce. |
| c | No receipt, the nonce still unused, and no node has shown any of its transactions for 600 seconds (`RESEND_AFTER_SECONDS`). | The same root and total are signed again at the same nonce with fees taken fresh, the new hash is recorded, then it is sent. One nonce carries one mined transaction, so this replaces the lost post and never adds a second. At most 5 times (`MAX_RESENDS`) in one process, then it says so once and waits for a receipt or for the nonce to be used. |

The nonce is read before the receipts, so a post mined between the two reads shows as its receipt and not as a used
nonce. A version recorded before nonces were kept is built again only after no node has known it for 600 seconds
(`UNSENT_AFTER_SECONDS`), and is never signed again.

Then reconcile checks what the vault itself shows, at one block. The three cases:

| Case | What the worker finds | What it records |
| --- | --- | --- |
| 1 | The newest version is built, and its root is the vault's pending root. The post reached the chain and the worker stopped before writing it down. | The version is posted, with no transaction hash and the vault's own claimable time. |
| 2 | A built version's root is the root the vault pays now. | The version is posted, with the block's time. Activate then marks it active in the same run. |
| 3 | The newest posted version's root is neither pending nor paid, no newer version ever reached the vault, and the read is at least 120 seconds after that version was posted. | The version is cancelled: the owner cancelled it with `cancelRoot`, or replaced the agent with `setAgent`. |

The 120 seconds are `CANCEL_MARGIN_SECONDS`. A public RPC is load balanced, and a node a few blocks behind still shows
the vault as it was before the worker's own post. Two minutes is far longer than that lag and far shorter than the hour
a root waits at least (the vault's minimum root delay, 3,600 seconds), so a real cancel is still recorded long before
the delay would have ended. Inside the margin nothing is recorded and publish posts nothing, because the newest posted
list is missing from the read. A version with no claimable time, or a vault whose delay cannot be read, proves no cancel.
An older posted version with a newer one on chain after it may have been replaced instead of cancelled, which the
vault's state cannot tell apart, so it is left as it is. Cases 1 and 2 cannot be misled by a lagging node: an older
view of the vault shows the worker's root pending or paid only if it was posted.

#### Publish

Publish posts nothing when no wallet holds a slot yet, when a version is `sending`, when a root is pending on the vault,
when the vault already pays exactly this list, when the slot holders are exactly the newest posted or active version, when
the owner cancelled exactly this list, when the newest posted version is missing from the read (the margin above), or
when no list on record rebuilds the vault's active root. Otherwise it builds the list from the slot holders in slot order
(a full wallet at the campaign's reward, a partial wallet at its share rounded down), records it as a new version, reads
the stored text back, and calls `postRoot`, which checks the vault against the factory's `VaultCreated` log in the
recorded block and the campaign row (token, owner, agent and cap), that the agent is this key, that the vault is not
paused and the root can activate before the end, that the active root rebuilds from its own published list, and that the
vault can pay everything both lists may still owe (C32). Only then does the send above begin.

A campaign is served only by the agent its vault names: registration refuses an `--agent` that is not the vault's, and
`postRoot` refuses when this key is not the vault's agent. A campaign's slots are covered by what its vault holds:
registration refuses a campaign whose reward times slots is more than the vault still holds, and `postRoot` refuses a list
the vault could not pay (C54).

#### What the worker's key can send

Two calls, both from the agent key, and each is simulated before it is sent:

| Call | Who may call it | What the worker uses it for |
| --- | --- | --- |
| `postRoot(bytes32 root, uint256 declaredTotal)` | The agent only | Posting a list. |
| `claim(address account, uint256 cumulativeAmount, bytes32[] proof)` | Anyone; the vault pays the wallet in the leaf | Submitting a wallet's claim. |

It never calls an owner function (`deposit`, `cancelRoot`, `setAgent`, `extendEnd`, `pause`, `unpause`,
`withdrawAfterEnd`, `rescue`, the ownership calls), never signs anything on a wallet's behalf, and never reads the
owner's key. Everything else it does with the vault is a read. The rehearsal below checks on a fork that every
transaction the agent sent was a `postRoot` or a `claim` to a campaign vault, and that no log line holds a key or a
signature.

#### What it reads

Names only, from `packages/worker/src/campaign/config.ts`. The worker checks all eight before it connects, and a missing
or invalid one stops it at start with exit code 2, naming each on its own line and what it must be, never its value.

| Setting | Must be |
| --- | --- |
| `DATABASE_URL` | A `postgres://` or `postgresql://` connection string |
| `WORKER_PRIVATE_KEY` | `0x` and 64 hex characters: the agent key the campaign's vault names |
| `SERV_API_KEY` | The SERV API key |
| `SERV_BASE_URL` | An https URL |
| `SERV_GRAPH_ID` | A graph id starting `gr_` that Thuli has a translation for |
| `ETH_RPC_URL` | An https URL |
| `BLOCKSCOUT_ETH_API` | An https URL |
| `BASE_SEPOLIA_RPC_URL` | An https URL, or `http://127.0.0.1:PORT` for a local fork |
| `REPPO_API_KEY` (optional) | The key for the outside check of appeals. Left out, the appeal step is skipped and appeals wait in the queue |
| `REPPO_BASE_URL` (needed when the key is set) | An https URL |

It also reads two committed files: the factory record `packages/contracts/deployments/base-sepolia.json` (it must be a
Base Sepolia record, chain 84532) and the rulebook `packages/rulebook/thuli-rulebook.md` (it must not be empty). A
scrubber blanks every secret and URL, the Reppo key included, from a log line before it is printed.

The campaign's own terms do not come from these settings. They come from its database row: the reward per wallet, the
per-wallet cap, the partial share, the number of slots, the rulebook number, the screening settings it changes from the
defaults (only those), its opening and closing times, and `vault_block`. Starting another campaign needs no change to
the worker.

#### Commands

| Command | What it does | What it needs | What it refuses |
| --- | --- | --- | --- |
| `npm run db:migrate` | Brings the Postgres at `DATABASE_URL` up to date with `packages/store/migrations`, and prints what it applied. Safe to run again and from two places at once. | `DATABASE_URL` | A missing value, or one that is not a postgres connection string (exit 2). |
| `npm run vault:create -- --agent ADDRESS --cap USDC --deposit USDC [--days N] [--delay-hours N] [--send]` | Makes a campaign vault from the committed factory and funds it. Without `--send` it simulates and prints the plan and signs nothing. With `--send` the owner key sends exactly three transactions: `createVault`, `approve` of exactly the deposit, and `deposit`. Then it prints the `campaign:create` line to run next, with `--agent` filled in. | `PAYER_PRIVATE_KEY` (the owner's test key), the two committed records in `packages/contracts/deployments`, and, with `--send`, Base Sepolia ETH for gas. `BASE_SEPOLIA_RPC_URL` is optional: the public endpoint is used when it is unset. | An RPC that is not on chain 84532. A token that is not six decimal USDC. An agent that is the owner. An owner holding less USDC than the deposit. `--days` outside 1 to 365 (120 when left out) and `--delay-hours` outside 1 to 720 (1 when left out). An end too soon for the root delay plus the 1 hour minimum claim window. No factory contract at the recorded address. |
| `npm run campaign:create -- --id ID --name NAME --agent ADDRESS --vault-tx HASH --reward USDC --slots N [--partial-share-bps N] [--opens ISO] [--closes ISO] [--settings JSON] [--write]` | Reads the vault's creation transaction and its `state()` from Base Sepolia, checks that they agree, and prints the campaign. With `--write` it records the campaign in the store, with every vault term taken from the chain. It signs nothing and reads no private key. Run again with the same terms it changes nothing. | `BASE_SEPOLIA_RPC_URL` is optional as above. `DATABASE_URL`, with the database migrated, for `--write`. | A transaction that failed, was not sent to the committed factory, or does not hold exactly one `VaultCreated` log from it. A `state()` that disagrees with that log on token, owner, agent, cap or delay. An `--agent` that is not the vault's agent. A token that is not Base Sepolia USDC. A reward above the cap. A reward times slots above what the vault still holds (deposited less paid). A vault that has ended. `--slots` outside 1 to 100,000. `--partial-share-bps` outside 1 to 9,999 (5,000 when left out). `--closes` after the vault's end less its root delay less the minimum claim window. `--opens` not before closes. Settings the screening would not accept. An id that already holds different terms. |
| `npm run campaign:requeue -- --id CAMPAIGN --wallet ADDRESS [--write]` | Puts one failed ask back in the queue from the start, once an outage is over. Without `--write` it only says what it would do. | `DATABASE_URL`. No key is loaded. | Any ask that is not failed, a decided hold included, and a failed ask that has an appeal. |
| `npm run worker` | Runs the loop above until `Ctrl+C` or `SIGTERM`. `npm run worker -- --once` makes one run and exits. | The eight settings, the two committed files, a migrated database, and Base Sepolia ETH on the agent key for gas. | Any missing or invalid setting (exit 2, with every problem listed). An RPC that is not on chain 84532. A campaign whose agent is not this key fails when it comes to posting, with the cause logged, and the other campaigns carry on. |
| `npm run appeal:list -- --id CAMPAIGN` | Prints one block for each appeal of the campaign: the wallet, the ask's action and rule, the appeal's text, the outside check and the outcome. The only place an appeal's text is shown. | `DATABASE_URL`. No key is loaded. Changes nothing. | A campaign id that is not valid. |
| `npm run appeal:settle -- --id CAMPAIGN --wallet ADDRESS --outcome reversed\|upheld [--action full\|partial] [--note "..."] [--write]` | The owner's call on one appeal (4.6). Without `--write` it prints the store's own answer and writes nothing. | `DATABASE_URL`. No key is loaded. | An appeal already settled, a reversal with no action or no more generous one, an ask that changed after the appeal, an `--action` on an upheld appeal, a note that is not plain text of 1 to 1,000 characters. |
| `npm run appeal:export -- --id CAMPAIGN [--file PATH] [--write]` | Appends each checked appeal not yet in the file to a private file, with the outside check's whole verdict, as input for the next rulebook change. Without `--write` it only counts. | `DATABASE_URL`. No key is loaded. | A file holding any line that is not an exported appeal, or over 16 MB. |
| `npm run rehearse:campaign` | Runs the whole worker end to end on a private local fork of Base Sepolia made with Foundry's `anvil`. Six fresh signing keys each stand for one real Ethereum wallet whose history is read live. Live SERV screens the six asks, the approved wallets take the three slots, the fork's clock moves past the root delay, and the worker submits each claim. A second campaign shows a post sent but never recorded and then cancelled by the owner and never sent again, a stalled publish that sends nothing once a newer list is posted, and the owner pausing the vault across a list's activation. A third shows `anvil` dropping a post, which the worker signs again at the same nonce, and a claim waiting through a pause that uses up none of its tries. It prints `pass` or `FAIL` for each check and exits 1 if any fails. | Foundry's `anvil`, `BASE_SEPOLIA_RPC_URL` (the fork source), `SERV_API_KEY`, `SERV_BASE_URL`, `SERV_GRAPH_ID`, `ETH_RPC_URL` and `BLOCKSCOUT_ETH_API`. It loads no key from `.env`, uses an in-memory database and sends no transaction to a public network. | A `SERV_GRAPH_ID` Thuli has no translation for. A missing `anvil`. A pair of wallets that no longer shows one shared first funder, checked before any SERV call is spent. It makes at most 6 screenings (`MAX_SCREENINGS`). |
| `npm run vault:verify [-- --vault-tx HASH] [-- --network base]` | Verifies the factory and the campaign vaults on Basescan so every contract link opens readable source. Sends no transaction. | `EXPLORER_API_KEY`, and Foundry's `forge`. `EXPLORER_API_URL` and `BASE_SEPOLIA_RPC_URL` are optional. | A missing key, an RPC on another chain than the network named, a `--vault-tx` that failed, was not sent to the committed factory or holds other than one `VaultCreated` log from it. |
| `npm run consistency` | Measures repeatability: the same wallets, with the same facts, asked again through the production decision path, written with 95% intervals to the file the versions page reads. It draws 30 wallets (`--wallets`) and asks each 5 times (`--runs`) unless told otherwise. | The private replay files, and `SERV_API_KEY`, `SERV_BASE_URL` and `SERV_GRAPH_ID`. Every try is a fresh SERV call. | An existing log without `--resume`, so a measurement is never started twice. |
| `npm run test:db` | Runs the store and API tests one file at a time (`vitest run packages/store packages/api --no-file-parallelism`). The store tests run on an in-memory Postgres (PGlite). The campaign, limits, payment claim and injection tests also run on a real Postgres when `STORE_TEST_URL` is set. | Nothing. | Nothing is refused, so point `STORE_TEST_URL` at a scratch database: those tests empty its payment, cache and campaign tables. |

A one-time Base mainnet proof has commands: `npm run vault:deploy` and `npm run prove:vault` take `--network base`, and
they work on Base only with `--real-money` as well, and they sign nothing there without `--send`. They have a rehearsal mode,
`--fork`, which runs against a local fork of Base mainnet and writes only outside the committed records. The factory
deployment has been done (4.1), and the proof itself was run on 12 Nov 2026: a vault, a root, a claim that paid 1 real
USDC and a withdrawal of the rest, recorded in base-proof.json. `verify` needs a Base RPC that serves log queries.

#### Limits

What this screening does not see, what running as one process does not cover, and what the operator does by hand, is
listed under the non-goals in `docs/security/threat-model.md` (section C.2, standard 5) and on the limits page of the
docs. In short:

- A campaign pays as asks arrive, so a family is seen only as it grows. Until it reaches the group size, each of its
  wallets looks alone and can be approved. Screening a whole claim list at once, as the replay does, has no such gap.
- A campaign ask is linked through the wallet's direct first funder only. The replay follows a funding back through up
  to 6 single-use pass-through wallets (`MAX_TRACE_HOPS`).
- A first funder with 10,000 or more transactions sent, or with contract code, links nobody.
- The facts in the table above are not measured for a campaign.
- The worker is meant to run as one process. Two for a few seconds never pay twice, but they can post one list twice,
  which restarts that list's waiting time.
- A resend, then a restart, then the earlier transaction landing, then the owner cancelling that root, all before the next
  run, can post a cancelled list again. An equal-fee resend may be refused by a node that still holds the lost
  transaction, because the resend takes fresh fees with no bump; the worker tries again 10 minutes later, at most 5 times
  in a process.
- A claim the worker cannot submit in 10 tries is left for the wallet.
- An owner's cancel is recorded only after the margin, and a cancelled list is not posted again until the slot holders
  change. An owner who wants no further lists pauses the vault, which also stops every claim while it lasts.
- Locking a campaign costs an attacker the lifetime ask cap times the cost of one funded wallet, at least 1,000 wallets
  that each hold a balance or have sent a transaction, and one set of funded wallets can fill every campaign's cap.
  An attacker with many addresses and aged wallets can use up a day's 2,000 model screenings, and the real asks then wait
  until after midnight.
- A campaign ask is screened on one chain's history, Ethereum or Base, whichever the wallet was active on first. A wallet
  used mostly on a third chain looks new, and only native ETH counts. The free check, the paid API and the replay read
  Ethereum only. Every threshold and the false-hold rate were measured on Ethereum history; nothing was measured on Base.
- Owner sign-in is not built, so an operator's command settles appeals. The scorecard does not score appeals, and no
  Reppo evaluation has been run for an appeal yet.
