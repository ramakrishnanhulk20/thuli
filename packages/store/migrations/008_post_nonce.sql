-- The transaction that posts a list's root is kept by its nonce as well as its hash: a sent transaction the network has
-- not mined can be replaced at the same nonce, and only the nonce says which one the vault will see. So the nonce is
-- stored with the hash, travels with it on a resend, and is cleared with it when the send is undone (C27, C32). A row
-- written before this file keeps no nonce.
ALTER TABLE list_versions ADD COLUMN post_nonce bigint NULL CHECK (post_nonce >= 0);
ALTER TABLE list_versions ADD CONSTRAINT list_versions_nonce_with_hash CHECK (post_nonce IS NULL OR post_tx IS NOT NULL);
