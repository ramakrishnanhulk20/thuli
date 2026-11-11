-- Lets the worker wait out an outage. An ask or a claim whose try failed for a reason outside its own data is queued
-- again with a time before which no worker takes it, so a SERV or chain outage cannot burn every attempt in seconds.
-- The store's code caps both the delay and the attempts (C41).
ALTER TABLE asks ADD COLUMN retry_at timestamptz NULL;
ALTER TABLE asks ADD CONSTRAINT asks_retry_check CHECK (retry_at IS NULL OR status = 'queued');

ALTER TABLE claim_relays ADD COLUMN retry_at timestamptz NULL;
ALTER TABLE claim_relays ADD CONSTRAINT claim_relays_retry_check CHECK (retry_at IS NULL OR status = 'pending');
-- The backstop for MAX_RELAY_ATTEMPTS, which rose from 5 to 10.
ALTER TABLE claim_relays
  DROP CONSTRAINT claim_relays_attempts_check,
  ADD CONSTRAINT claim_relays_attempts_check CHECK (attempts BETWEEN 0 AND 10);

-- A root the worker finds pending on the vault after a restart is recorded as posted without the hash of a transaction
-- it never saw. The time it becomes claimable is always known, because the vault holds it, so that stays required.
ALTER TABLE list_versions
  DROP CONSTRAINT list_versions_check,
  DROP CONSTRAINT list_versions_check1,
  DROP CONSTRAINT list_versions_check2,
  ADD CONSTRAINT list_versions_tx_has_time CHECK (post_tx IS NULL OR claimable_at IS NOT NULL),
  ADD CONSTRAINT list_versions_built_unposted CHECK (status <> 'built' OR (post_tx IS NULL AND claimable_at IS NULL)),
  ADD CONSTRAINT list_versions_posted_time CHECK (status NOT IN ('posted', 'active', 'superseded') OR claimable_at IS NOT NULL);

-- The block of the transaction that created the campaign's vault, where the worker starts reading the vault's history.
ALTER TABLE campaigns ADD COLUMN vault_block bigint NULL CHECK (vault_block > 0);
