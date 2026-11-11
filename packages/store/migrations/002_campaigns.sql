-- One live reward campaign: who asked, what Thuli decided, which wallets hold a paid slot, every list posted to the
-- vault, and the claims the worker submits for wallets. These rows are the record of what was asked, decided and
-- paid, not caches, so sweep never deletes them: forgetting an ask would let a wallet ask twice, and forgetting a slot
-- would hand its number out again (C44).
--
-- Addresses hold only the canonical EIP-55 form from parseAddress (C1); the pattern is a backstop for a caller that
-- skipped it. Amounts are base units written as decimal digits with no sign, point or leading zero, so one amount has
-- exactly one spelling. Times come from the caller's clock, as in 001_init.sql. Every text column that takes outside
-- input has a length check (C41).

CREATE TABLE campaigns (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{1,128}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  chain integer NOT NULL CHECK (chain > 0),
  vault text NOT NULL CHECK (length(vault) = 42 AND vault ~ '^0x[0-9a-fA-F]{40}$'),
  token text NOT NULL CHECK (length(token) = 42 AND token ~ '^0x[0-9a-fA-F]{40}$'),
  owner text NOT NULL CHECK (length(owner) = 42 AND owner ~ '^0x[0-9a-fA-F]{40}$'),
  agent text NOT NULL CHECK (length(agent) = 42 AND agent ~ '^0x[0-9a-fA-F]{40}$'),
  reward_per_wallet text NOT NULL CHECK (reward_per_wallet ~ '^[1-9][0-9]{0,77}$'),
  per_wallet_cap text NOT NULL CHECK (per_wallet_cap ~ '^[1-9][0-9]{0,77}$'),
  partial_share_bps integer NOT NULL CHECK (partial_share_bps BETWEEN 1 AND 9999),
  max_slots integer NOT NULL CHECK (max_slots BETWEEN 1 AND 100000),
  rulebook integer NOT NULL CHECK (rulebook >= 1),
  -- Only the screening settings this campaign changes from the defaults, checked against core's Settings on the way in.
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object' AND length(settings::text) <= 2048),
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (closes_at > opens_at),
  -- The vault pays no wallet past its cap, so a full reward above the cap could never be claimed in full.
  CHECK (reward_per_wallet::numeric <= per_wallet_cap::numeric)
);

-- One ask per wallet per campaign (C42). A decision is written whole or not at all, and only an approved ask holds a
-- slot. The signature is kept as the wallet's proof of control; no public read returns it (C40).
CREATE TABLE asks (
  campaign_id text NOT NULL REFERENCES campaigns (id),
  wallet text NOT NULL CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-fA-F]{40}$'),
  signed_at bigint NOT NULL CHECK (signed_at >= 0),
  signature text NOT NULL CHECK (length(signature) = 132 AND signature ~ '^0x[0-9a-fA-F]{130}$'),
  asked_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'screening', 'decided', 'failed')),
  lease_until timestamptz NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  action text NULL CHECK (action IN ('full', 'partial', 'hold', 'exclude')),
  share_bps integer NULL,
  rule text NULL CHECK (rule ~ '^[A-Z][0-9]{1,2}$'),
  reason text NULL CHECK (length(reason) BETWEEN 1 AND 400),
  cited_txs jsonb NULL CHECK (
    jsonb_typeof(cited_txs) = 'array'
    AND jsonb_array_length(cited_txs) <= 256
    AND NOT jsonb_path_exists(cited_txs, 'strict $[*] ? (@.type() != "string" || !(@ like_regex "^0x[0-9a-f]{64}$"))')
  ),
  not_checked jsonb NULL CHECK (
    jsonb_typeof(not_checked) = 'array'
    AND jsonb_array_length(not_checked) <= 16
    AND NOT jsonb_path_exists(not_checked, 'strict $[*] ? (@.type() != "string" || !(@ like_regex "^.{1,64}$" flag "s"))')
  ),
  -- The public chain facts a decision rested on, so the worker can count the asking wallets one funder paid.
  facts jsonb NULL CHECK (
    jsonb_typeof(facts) = 'object'
    AND length(facts::text) <= 4096
    AND (jsonb_typeof(facts -> 'funder') <> 'object' OR (facts -> 'funder' ->> 'address') ~ '^0x[0-9a-fA-F]{40}$')
  ),
  serv_request_id text NULL CHECK (serv_request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  decided_at timestamptz NULL,
  slot integer NULL CHECK (slot >= 1),
  PRIMARY KEY (campaign_id, wallet),
  UNIQUE (campaign_id, slot),
  CHECK ((status = 'screening') = (lease_until IS NOT NULL)),
  CHECK ((status IN ('decided', 'failed')) = (action IS NOT NULL)),
  CHECK (
    (action IS NULL) = (share_bps IS NULL)
    AND (action IS NULL) = (rule IS NULL)
    AND (action IS NULL) = (reason IS NULL)
    AND (action IS NULL) = (cited_txs IS NULL)
    AND (action IS NULL) = (not_checked IS NULL)
    AND (action IS NULL) = (decided_at IS NULL)
  ),
  CHECK ((status = 'decided') = (facts IS NOT NULL)),
  CHECK (serv_request_id IS NULL OR action IS NOT NULL),
  CHECK (
    action IS NULL
    OR (action = 'full' AND share_bps = 10000)
    OR (action = 'partial' AND share_bps BETWEEN 1 AND 9999)
    OR (action IN ('hold', 'exclude') AND share_bps = 0)
  ),
  CHECK (slot IS NULL OR (status = 'decided' AND action IN ('full', 'partial')))
);

CREATE INDEX asks_waiting ON asks (asked_at) WHERE status IN ('queued', 'screening');
CREATE INDEX asks_board ON asks (campaign_id, decided_at) WHERE decided_at IS NOT NULL;

-- Each list of slot holders as published, with its Merkle root. The text is kept exactly as published, so anyone can
-- rebuild the root from it (C32); 12,000,000 characters is the most the worker's reader accepts.
CREATE TABLE list_versions (
  campaign_id text NOT NULL REFERENCES campaigns (id),
  version integer NOT NULL CHECK (version >= 1),
  root text NOT NULL CHECK (root ~ '^0x[0-9a-f]{64}$'),
  published_list text NOT NULL CHECK (length(published_list) BETWEEN 2 AND 12000000),
  declared_total text NOT NULL CHECK (declared_total ~ '^(0|[1-9][0-9]{0,77})$'),
  status text NOT NULL CHECK (status IN ('built', 'posted', 'active', 'superseded', 'cancelled')),
  post_tx text NULL CHECK (post_tx ~ '^0x[0-9a-f]{64}$'),
  claimable_at bigint NULL CHECK (claimable_at >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (campaign_id, version),
  CHECK ((post_tx IS NULL) = (claimable_at IS NULL)),
  CHECK (status <> 'built' OR post_tx IS NULL),
  CHECK (status NOT IN ('posted', 'active', 'superseded') OR post_tx IS NOT NULL)
);

-- The vault has one active root at a time, so the record does too.
CREATE UNIQUE INDEX list_versions_one_active ON list_versions (campaign_id) WHERE status = 'active';

-- A claim the worker submits for a wallet so the money arrives without the wallet paying gas. 'sent' is the leased
-- state: a worker holds the row until updated_at plus its lease, then another may take it again.
CREATE TABLE claim_relays (
  campaign_id text NOT NULL,
  wallet text NOT NULL CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-fA-F]{40}$'),
  version integer NOT NULL,
  amount text NOT NULL CHECK (amount ~ '^[1-9][0-9]{0,77}$'),
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  tx text NULL CHECK (tx ~ '^0x[0-9a-f]{64}$'),
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 5),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (campaign_id, wallet, version),
  FOREIGN KEY (campaign_id, version) REFERENCES list_versions (campaign_id, version)
);

CREATE INDEX claim_relays_waiting ON claim_relays (updated_at) WHERE status IN ('pending', 'sent');
