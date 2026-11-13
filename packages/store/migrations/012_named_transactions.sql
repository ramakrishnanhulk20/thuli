-- Every transaction hash a facilitator has named for a payment whose settlement is not proven yet, kept with its claim
-- (C25). A facilitator can name a transaction and then refuse to answer for that payment again, so a later copy of the
-- same header must be able to read those receipts itself. Lowercase hashes, at most 8: one settle is at most two
-- facilitator calls, and a claim is tried a handful of times inside its window. While a claim is unsure and holds a
-- hash it outlives its authorization, by the code's PAID_RESULT_KEEP_SECONDS, so its buyer can still come back.
ALTER TABLE payment_claims
  ADD COLUMN named_txs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(named_txs) = 'array' AND jsonb_array_length(named_txs) <= 8);
