-- Memoria di Jarvis per ogni locale: note di Riccardo e riassunto dell'ultimo menu online.
CREATE TABLE IF NOT EXISTS venue_memory (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('nota', 'menu')),
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS venue_memory_client ON venue_memory(client_id, kind, archived_at);
