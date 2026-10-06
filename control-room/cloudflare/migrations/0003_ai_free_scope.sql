-- Apply ONLY to the dedicated private staging D1 database, never to public RenMenu.
-- All existing requests remain non-fixtures. Only a separately reviewed D1
-- migration operation may mark the one synthetic record; no API exposes it.
ALTER TABLE requests ADD COLUMN is_ai_test_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_ai_test_fixture IN (0,1));
ALTER TABLE requests ADD COLUMN ai_test_source_sha256 TEXT;
ALTER TABLE requests ADD COLUMN ai_test_extraction_sha256 TEXT;

-- One atomic write reserves a slot before AI.run. Failures and timeouts also
-- consume that slot: a retry cannot silently double-spend the free allocation.
CREATE TABLE IF NOT EXISTS ai_inference_attempts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  action TEXT NOT NULL CHECK (action IN ('classify','extract')),
  request_revision INTEGER NOT NULL,
  day_utc TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','completed','failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (request_id, action, day_utc, slot)
);
CREATE INDEX IF NOT EXISTS idx_ai_attempts_day ON ai_inference_attempts(day_utc, request_id);
