-- Reppo's whole verdict on an appeal, and a check whose route Thuli does not know. A check Reppo answered and charged
-- for is checked whatever its route says, so it is never sent again (C23): what marks it checked is the charge, and the
-- route is kept only when it is one of the three Thuli knows. Every row written before this file already has both.
--
-- reppo_score, reppo_decision and reppo_confidence are Reppo's own values, kept for the operator's command only. They
-- are private: no public read selects them (C40). Their bounds are core's ReppoVerdict, which the code checks first;
-- these are the backstop (C41).
ALTER TABLE appeals
  ADD COLUMN reppo_score integer NULL CHECK (reppo_score BETWEEN 0 AND 100),
  ADD COLUMN reppo_decision text NULL CHECK (length(reppo_decision) BETWEEN 1 AND 64),
  ADD COLUMN reppo_confidence text NULL CHECK (reppo_confidence IN ('low', 'medium', 'high'));

-- appeals_check2 is the name Postgres gave 006's rule that a checked appeal has both a route and a charge.
ALTER TABLE appeals
  DROP CONSTRAINT appeals_check2,
  ADD CONSTRAINT appeals_checked_charged CHECK ((check_status = 'checked') = (credits_charged IS NOT NULL)),
  ADD CONSTRAINT appeals_route_checked CHECK (reppo_route IS NULL OR check_status = 'checked'),
  ADD CONSTRAINT appeals_verdict_checked CHECK (
    check_status = 'checked' OR (reppo_score IS NULL AND reppo_decision IS NULL AND reppo_confidence IS NULL)
  );
