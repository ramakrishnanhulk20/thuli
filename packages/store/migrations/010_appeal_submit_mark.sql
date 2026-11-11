-- Two more things an appeal's outside check keeps, both private: no public read selects them (C40).
--
-- submit_started_at is set the moment a worker is about to send the appeal to the outside check, before the call. That
-- check charges for every submit and cannot recognise one sent twice, so an appeal with this mark and no evaluation id
-- may already have been paid for, and is never sent again (C23). Once set it is never cleared.
--
-- check_note says in a few fixed words why a check ended unchecked, such as the decision changing after the appeal.
-- Every row written before this file has neither, which these rules allow.
ALTER TABLE appeals
  ADD COLUMN submit_started_at timestamptz NULL,
  ADD COLUMN check_note text NULL CHECK (length(check_note) BETWEEN 1 AND 120),
  ADD CONSTRAINT appeals_note_unchecked CHECK (check_note IS NULL OR check_status = 'unchecked');
