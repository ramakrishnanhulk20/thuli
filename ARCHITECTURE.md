# Thuli architecture

Thuli is Tamil for "a drop": every drop of an airdrop lands in a real hand.

Picked 27 Oct 2026: a screening service with an immutable reward vault on Base (PLAN.md, Option 2). The numbered
rules (C1 to C45) are in docs/security/threat-model.md. This file grows the interface section (addresses, ABI, the
exact reads and writes the UI makes) as the backend lands.

## 1. System overview

```mermaid
flowchart LR
  subgraph Public
    V[Visitor or judge]
    C[Claimant wallet]
    A[Paying agent]
  end
  O[Campaign owner]

  subgraph Vercel["Web app on Vercel (no money keys)"]
    UI[Pages: landing, replay, check a wallet, wallet page, appeal, docs]
    API[API routes]
    X402[Paid screen route, x402 receive]
  end

  subgraph Worker["Screening worker (holds spending power)"]
    Q[Job queue reader]
    F[Facts engine: chain reads, funding and sweep graph, clusters]
    G[Rules graph on SERV: script nodes, Jev decision nodes, agent node]
    P[Paid data through Kite Passport]
    S[Dolphin summaries]
    R[Reppo second opinion]
    K[Root signer]
  end

  DB[(Postgres)]
  CH[(Public RPC: Ethereum, Base)]
  N[Nansen and Allium x402]
  SERV[SERV Reasoning]
  DOL[Dolphin API]
  REP[Reppo Eval API]
  KITE[Kite Agent Passport]
  VAULT[[Reward vault on Base, one per campaign, from a factory]]

  V --> UI
  C --> UI
  O --> UI
  A --> X402
  UI --> API
  API --> DB
  X402 --> DB
  DB --> Q
  Q --> F
  F --> CH
  F --> P
  P --> KITE
  KITE --> N
  F --> S
  S --> DOL
  F --> G
  G --> SERV
  G --> R
  R --> REP
  G --> DB
  K --> VAULT
  C --> VAULT
  O --> VAULT
```

## 2. Main sequence: one campaign, from upload to a claim

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner
  participant W as Web app
  participant DB as Postgres
  participant K as Worker
  participant Kite as Kite Passport
  participant N as Nansen (x402)
  participant SV as SERV
  participant RP as Reppo
  participant V as Vault (Base)
  participant C as Claimant

  O->>W: Sign in with wallet, create campaign, write rules, upload claim list
  O->>W: Prepay per wallet (x402, USDC on Base)
  W->>DB: Store campaign, rules version, wallets, payment receipt
  O->>V: Deploy vault from factory, deposit USDC, set per-wallet cap, end time, root delay
  W->>DB: Queue screening job
  K->>DB: Take job
  loop each wallet
    K->>K: Free chain reads, facts in code, ceiling set by code (C12)
    K->>Kite: kpass session execute (first funder), inside campaign budget (C21)
    Kite->>N: Pay and call
    N-->>K: Funder address and label
    K->>SV: Rules (system) + facts (user), Prompt Guard on stranger text
    SV-->>K: Action, share, reason, cited tx hashes
    K->>K: Check output like input (C13), never above ceiling (C12)
    K->>DB: Decision, reason, receipts, request ids
  end
  K->>RP: Held clusters, addresses and hashes stripped (C35)
  RP-->>K: Score, accept or revise or reject, critique
  O->>W: Review held wallets, publish
  W->>DB: Freeze list version, queue root job
  K->>K: Rebuild root from the public list (C32)
  K->>V: Post root (agent key can only post roots)
  Note over V: Root waits the owner-set delay, owner can cancel (C30)
  C->>W: Open wallet page, see decision and reason
  C->>V: Claim with Merkle proof, paid the difference from what was already claimed (C27)
```

## 3. Module dependency graph

```mermaid
flowchart TB
  subgraph contracts["packages/contracts"]
    VF["ThuliVaultFactory"]
    VA["ThuliVault: deposit, postRoot, cancelRoot, claim, withdrawAfterEnd"]
    VF --> VA
    VA --> OZ["OpenZeppelin: MerkleProof, SafeERC20, ReentrancyGuard, Ownable2Step"]
  end

  subgraph core["packages/core, shared TypeScript"]
    ADDR["address: one canonical parser, C1"]
    CHAIN["chains: config map, C2"]
    MONEY["money: shares to base units, round down, C3"]
    LEAF["leaf: Merkle leaf encoding shared with the contract, C28"]
    SCHEMA["schemas: request, decision, API response, C13 and C34"]
  end

  subgraph worker["packages/worker"]
    FACTS["facts: chain reads, graph, clusters, fan-out rule, C15 and C16"]
    PAY["paid data: kpass wrapper, argument array, price and payee checks, C22 C23 C37"]
    DOLC["dolphin client"]
    SERVC["serv client: rules graph, ceilings, C12 and C14"]
    REPC["reppo client: payload stripper, C35"]
    ROOT["root signer, C32 and C39"]
  end

  subgraph web["packages/web"]
    PAGES["pages and components, text-only rendering, C33"]
    ROUTES["api routes: auth, campaigns, check, appeals, publish"]
    X4["x402 receive: settle before return, C25"]
  end

  FACTS --> ADDR
  FACTS --> CHAIN
  PAY --> ADDR
  SERVC --> SCHEMA
  SERVC --> FACTS
  SERVC --> DOLC
  SERVC --> PAY
  REPC --> SCHEMA
  ROOT --> LEAF
  ROOT --> MONEY
  ROUTES --> ADDR
  ROUTES --> SCHEMA
  X4 --> SCHEMA
  PAGES --> ROUTES
  LEAF -.same encoding.- VA
```

## 4. Interface for the frontend

Filled in at M7 when the vault is deployed and verified: addresses, ABI, and every read and write the UI makes.
