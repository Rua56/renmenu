-- Apply ONLY to the dedicated private staging D1 database, never to public RenMenu.
-- Additive (2026-10-13): proposte di miglioramento di Jarvis. Una volta a settimana Jarvis legge il
-- proprio diario, propone al massimo 3 migliorie con i numeri che le giustificano e Riccardo
-- risponde Fallo, Non ora o Mai. Le risposte restano qui: un «Mai» non viene più riproposto.
CREATE TABLE IF NOT EXISTS jarvis_proposals (
  id TEXT PRIMARY KEY,
  week TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('operativa','commerciale','codice')),
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  evidence TEXT NOT NULL,
  proposal TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'nuova' CHECK (status IN ('nuova','accettata','rimandata','rifiutata')),
  model TEXT,
  digest_json TEXT NOT NULL DEFAULT '{}',
  issue_url TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jarvis_proposals_week ON jarvis_proposals(week);
CREATE INDEX IF NOT EXISTS idx_jarvis_proposals_status ON jarvis_proposals(status, created_at);
