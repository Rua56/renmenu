-- Apply ONLY to the dedicated private staging D1 database, never to public RenMenu.
-- Additive and non-destructive: stores where each extracted name/price came from
-- ("riga N" of the received text). Existing drafts get '[]' (no provenance recorded).
-- A manual save resets it to '[]', as in the demo: references to the extracted
-- version do not attest manual edits.
-- Apply BEFORE deploying the code that writes drafts.provenance_json; the API read
-- path tolerates its absence (fallback query).
ALTER TABLE drafts ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '[]';
