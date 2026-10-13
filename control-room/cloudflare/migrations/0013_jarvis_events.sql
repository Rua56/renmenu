-- Apply ONLY to the dedicated private staging D1 database, never to public RenMenu.
-- Additive (2026-10-13): diario di Jarvis. Gli eventi che il registro (audit_events) non conserva,
-- per esempio gli errori dell'orologio sulle missioni, con un tipo fisso e un dettaglio JSON.
-- Serve al riepilogo settimanale e, più avanti, alle proposte di miglioramento.
CREATE TABLE IF NOT EXISTS jarvis_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  request_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jarvis_events_kind ON jarvis_events(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_jarvis_events_created ON jarvis_events(created_at);
