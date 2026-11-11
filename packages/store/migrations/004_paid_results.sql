-- A payment claim now keeps what its payment bought, so a buyer whose request ended after the money moved (a slow
-- screening, a host that cut the request, a crash, a lost reply) can send the same payment header again and get the
-- screening, without paying twice (C25). Two states follow held and unsure:
-- - settled: the money moved and no result is stored yet. owner is the one request screening it, if any, and
--   owned_until is the moment that request is surely over, so one that died mid-screening frees it by itself.
-- - served: the result is stored in result, exactly as it passed the output check, and owned by no request.
-- Both keep the wallet the payment was for, the settlement transaction and the second it settled, and are kept for a
-- day from that second. used is what the code before this wrote for a settlement: such a row has no wallet and no
-- transaction, so it is never redeemed and is refused as before until it expires.
ALTER TABLE payment_claims
  ADD COLUMN wallet text NULL CHECK (wallet ~ '^0x[0-9a-fA-F]{40}$'),
  ADD COLUMN tx text NULL CHECK (tx ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN settled_at bigint NULL,
  ADD COLUMN owned_until bigint NULL,
  -- A real result is about 2 KB; the size check stops a caller that skipped the output check from growing a row (C41).
  ADD COLUMN result jsonb NULL CHECK (octet_length(result::text) <= 16384),
  DROP CONSTRAINT payment_claims_state_check,
  ADD CONSTRAINT payment_claims_state_check CHECK (state IN ('held', 'unsure', 'used', 'settled', 'served')),
  DROP CONSTRAINT payment_claims_check,
  ADD CONSTRAINT payment_claims_owner_by_state CHECK (CASE state WHEN 'held' THEN owner IS NOT NULL WHEN 'settled' THEN true ELSE owner IS NULL END),
  ADD CONSTRAINT payment_claims_owned_until CHECK ((state = 'settled' AND owner IS NOT NULL) = (owned_until IS NOT NULL)),
  ADD CONSTRAINT payment_claims_settlement CHECK ((state IN ('settled', 'served')) = (wallet IS NOT NULL AND tx IS NOT NULL AND settled_at IS NOT NULL)),
  ADD CONSTRAINT payment_claims_result CHECK ((state = 'served') = (result IS NOT NULL));
