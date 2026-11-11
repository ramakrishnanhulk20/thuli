-- A list version can now be sending: the worker has broadcast the transaction that posts its root and recorded the
-- hash before waiting for it to be mined. A stop or a timeout during that wait then leaves a record that the root may
-- be on the vault, so the worker settles it instead of posting the same list again (C27, C32).
--
-- What each status may hold: built has no hash and no claimable time; sending has a hash and no claimable time,
-- because the vault sets that time only once the transaction is mined; posted, active and superseded have a claimable
-- time, with or without a hash. Every row 002 and 003 allowed is still allowed.
ALTER TABLE list_versions
  DROP CONSTRAINT list_versions_status_check,
  ADD CONSTRAINT list_versions_status_check
    CHECK (status IN ('built', 'sending', 'posted', 'active', 'superseded', 'cancelled')),
  DROP CONSTRAINT list_versions_tx_has_time,
  ADD CONSTRAINT list_versions_tx_has_time CHECK (status = 'sending' OR post_tx IS NULL OR claimable_at IS NOT NULL),
  ADD CONSTRAINT list_versions_sending_hash CHECK (status <> 'sending' OR (post_tx IS NOT NULL AND claimable_at IS NULL));
