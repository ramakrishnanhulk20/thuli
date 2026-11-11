-- How many times an appeal's submit to the outside check ended unclear: sent, perhaps charged for, with no evaluation
-- id to show for it. countUnclearSubmit adds one and clears the submit mark in the same statement, and nothing in the
-- store ever lowers it, so the store can always say how many times the check may have been paid for with nothing to
-- show (C56). The worker ends the appeal once this reaches its limit. Every row written before this file counts 0.
ALTER TABLE appeals ADD COLUMN unclear_submits integer NOT NULL DEFAULT 0 CHECK (unclear_submits >= 0);
