-- A settled payment counts the screenings started for it, so one payment buys at most REDEEM_SCREEN_TRIES of them,
-- however often its header comes back (C26). The count rises in the same step that takes ownership of the claim, so two
-- requests can never both start the last try. owner_counted says whether the current owner's taking counted one; only
-- such an owner can hand its try back, when it never started that screening, so no caller can reopen a spent claim. A
-- row settled before this file has started none. The upper bound is a backstop well above the code's own limit.
ALTER TABLE payment_claims
  ADD COLUMN screenings integer NOT NULL DEFAULT 0 CHECK (screenings BETWEEN 0 AND 10),
  ADD COLUMN owner_counted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT payment_claims_owner_counted CHECK (NOT owner_counted OR (state = 'settled' AND owner IS NOT NULL));
