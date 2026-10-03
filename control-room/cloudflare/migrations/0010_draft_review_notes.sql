-- Apply ONLY to the dedicated private staging D1 database, never to public RenMenu.
-- Additive: what Jarvis could not put into the draft, line by line and grouped by type
-- (menu rows not read, corrections, coperto, hours, contacts, plan, theme, other text).
ALTER TABLE drafts ADD COLUMN review_notes_json TEXT NOT NULL DEFAULT '[]';
