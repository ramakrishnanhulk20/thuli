-- The wallet a payment claim was first taken for (C25). A claim whose settlement is not proven yet can be taken again
-- by a later copy of its header, and may then be served on the receipt of a transaction a facilitator named for it. A
-- mined transaction shows everything needed to rebuild that header, so a copy must not be able to move the payment to
-- another wallet: from its first taking on, a claim is taken again only for this wallet. Checksummed, the form the
-- code's one address parser gives. NULL only on a row written before this file, which takes the wallet of its next
-- taker.
ALTER TABLE payment_claims
  ADD COLUMN for_wallet text NULL CHECK (for_wallet ~ '^0x[0-9a-fA-F]{40}$');
