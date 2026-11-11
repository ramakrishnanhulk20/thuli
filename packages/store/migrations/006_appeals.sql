-- Appeals in the live campaign. A wallet whose ask was held, excluded, cut to a partial reward or failed files one
-- appeal; the worker has Reppo's outside judges check Thuli's decision; the campaign's owner settles it. Like every
-- campaign row these are records, not caches, so sweep leaves them alone.

-- The flat record a decision rested on, the same object the worker gives SERV, kept so the outside check can be made
-- later. Private: no public read selects it. The code caps it at 16 KB; this is the backstop.
ALTER TABLE asks ADD COLUMN record jsonb NULL CHECK (jsonb_typeof(record) = 'object' AND length(record::text) <= 32768);
ALTER TABLE asks ADD CONSTRAINT asks_record_decided CHECK (record IS NULL OR status = 'decided');

-- Set only by settling an appeal as reversed, so the ask's rule and reason stay as the record of what was appealed.
ALTER TABLE asks ADD COLUMN reversed_by_appeal boolean NOT NULL DEFAULT false;

-- A failed ask that an appeal reverses becomes decided, by the owner, with no facts read. Every other decided ask still
-- has its facts.
ALTER TABLE asks
  DROP CONSTRAINT asks_check3,
  ADD CONSTRAINT asks_facts_decided CHECK (facts IS NULL OR status = 'decided'),
  ADD CONSTRAINT asks_decided_facts CHECK (status <> 'decided' OR facts IS NOT NULL OR reversed_by_appeal),
  ADD CONSTRAINT asks_reversed_decided CHECK (NOT reversed_by_appeal OR (status = 'decided' AND action IN ('full', 'partial')));

-- One appeal per ask. text, text_hash, signature and owner_note are private: no public read selects them (C40). It has
-- no foreign key to asks: no code ever deletes an ask, and addAppeal files an appeal only for an ask it has just read
-- under the campaign's lock, so a key would add no safety and would make every TRUNCATE of asks name appeals as well.
CREATE TABLE appeals (
  campaign_id text NOT NULL,
  wallet text NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  text_hash text NOT NULL CHECK (text_hash ~ '^0x[0-9a-f]{64}$'),
  signed_at bigint NOT NULL CHECK (signed_at >= 0),
  signature text NOT NULL CHECK (length(signature) = 132 AND signature ~ '^0x[0-9a-fA-F]{130}$'),
  appealed_action text NOT NULL CHECK (appealed_action IN ('partial', 'hold', 'exclude')),
  appealed_rule text NOT NULL CHECK (appealed_rule ~ '^[A-Z][0-9]{1,2}$'),
  filed_at timestamptz NOT NULL,
  check_status text NOT NULL CHECK (check_status IN ('queued', 'checking', 'checked', 'unchecked')),
  lease_until timestamptz NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  retry_at timestamptz NULL,
  reppo_eval_id text NULL CHECK (reppo_eval_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  reppo_route text NULL CHECK (reppo_route IN ('ship', 'review', 'block')),
  reppo_note text NULL CHECK (length(reppo_note) BETWEEN 1 AND 280),
  credits_charged integer NULL CHECK (credits_charged >= 0),
  checked_at timestamptz NULL,
  outcome text NOT NULL CHECK (outcome IN ('open', 'reversed', 'upheld')),
  new_action text NULL CHECK (new_action IN ('full', 'partial')),
  owner_note text NULL CHECK (length(owner_note) BETWEEN 1 AND 1000),
  settled_at timestamptz NULL,
  PRIMARY KEY (campaign_id, wallet),
  CHECK ((check_status = 'checking') = (lease_until IS NOT NULL)),
  CHECK (retry_at IS NULL OR check_status = 'queued'),
  CHECK ((check_status = 'checked') = (reppo_route IS NOT NULL AND credits_charged IS NOT NULL)),
  CHECK (check_status = 'checked' OR reppo_note IS NULL),
  CHECK ((check_status IN ('checked', 'unchecked')) = (checked_at IS NOT NULL)),
  CHECK ((outcome = 'reversed') = (new_action IS NOT NULL)),
  CHECK ((outcome = 'open') = (settled_at IS NULL)),
  CHECK (outcome <> 'open' OR owner_note IS NULL)
);

CREATE INDEX appeals_waiting ON appeals (filed_at) WHERE check_status IN ('queued', 'checking');
