-- Allegati delle email (2026-10-03): foto e PDF che lo script Gmail di renmenu1569 manda a Jarvis.
-- Restano qui finché l'importer crea la pratica della stessa email, poi diventano materiali.
-- Solo staging Jarvis.
CREATE TABLE IF NOT EXISTS mail_files (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  material_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (message_id, part)
);
CREATE INDEX IF NOT EXISTS mail_files_pending ON mail_files (material_id, message_id);
