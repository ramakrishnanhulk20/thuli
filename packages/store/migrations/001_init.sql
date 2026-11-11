-- Every time column is written from the caller's clock, never from now() here, so two server copies that pass the same
-- moment get the same answer. Every text column that takes outside input carries a length check, so no caller can
-- grow a row past a stated size (threat model C41).

CREATE TABLE schema_migrations (
  name text PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 200),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL
);

-- One row per payment authorization (C25). A held row belongs to the one request settling it, so it alone has an
-- owner. valid_before is the authorization's own expiry in Unix seconds.
CREATE TABLE payment_claims (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('held', 'unsure', 'used')),
  owner text NULL CHECK (length(owner) BETWEEN 1 AND 64),
  valid_before bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((state = 'held') = (owner IS NOT NULL))
);

CREATE TABLE leases (
  id uuid PRIMARY KEY,
  pool text NOT NULL CHECK (length(pool) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL
);

CREATE INDEX leases_pool_expires_at ON leases (pool, expires_at);

CREATE TABLE rate_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 1 AND 40),
  client text NOT NULL CHECK (length(client) BETWEEN 1 AND 64),
  at timestamptz NOT NULL
);

CREATE INDEX rate_events_bucket_client_at ON rate_events (bucket, client, at);

CREATE TABLE day_counts (
  day date NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, name)
);

-- address holds only the canonical EIP-55 form from parseAddress (C1); the pattern is a backstop for a caller that
-- skipped it.
CREATE TABLE check_cache (
  address text NOT NULL CHECK (length(address) = 42 AND address ~ '^0x[0-9a-fA-F]{40}$'),
  chain integer NOT NULL CHECK (chain > 0),
  rulebook integer NOT NULL CHECK (rulebook > 0),
  body jsonb NOT NULL,
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (address, chain, rulebook)
);
