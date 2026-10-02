-- Jarvis autonomo (2026-10-02): pratiche affidate da Riccardo, coda email da inviare da Gmail
-- renmenu1569 e impostazioni del canale Telegram. Solo staging Jarvis.
CREATE TABLE IF NOT EXISTS jarvis_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jarvis_missions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  status TEXT NOT NULL CHECK (status IN ('affidata','attesa_invio','attesa_cliente','attesa_si','pubblicazione','verifica','completata','ferma','annullata')),
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  step_started_at TEXT NOT NULL,
  reminded_at TEXT,
  rounds INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jarvis_outbox (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES jarvis_missions(id),
  request_id TEXT NOT NULL REFERENCES requests(id),
  approval_id TEXT NOT NULL REFERENCES publication_approvals(id),
  reference_code TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_coda','inviata','errore','annullata')),
  trigger_count INTEGER NOT NULL DEFAULT 0,
  triggered_at TEXT,
  sent_at TEXT,
  gmail_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jarvis_outbox_status ON jarvis_outbox(status);
