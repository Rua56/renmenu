-- Run only after 0001_initial.sql in a dedicated Control Room D1 database.
-- No external integration is enabled by applying this migration.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS external_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('gmail', 'whatsapp')),
  source_event_id TEXT NOT NULL,
  request_id TEXT REFERENCES requests(id),
  status TEXT NOT NULL CHECK (status IN ('received', 'imported', 'ignored', 'needs_review')),
  reason TEXT,
  received_at TEXT NOT NULL,
  UNIQUE(source, source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_external_events_request ON external_events(request_id);

CREATE TABLE IF NOT EXISTS material_analyses (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL UNIQUE REFERENCES materials(id),
  request_id TEXT NOT NULL REFERENCES requests(id),
  source_sha256 TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('complete', 'needs_review', 'unreadable')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_material_analyses_request ON material_analyses(request_id);

CREATE TABLE IF NOT EXISTS live_pr_operations (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(id),
  revision INTEGER NOT NULL,
  snapshot_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  branch_name TEXT NOT NULL UNIQUE,
  pr_number INTEGER,
  pr_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'branch_created', 'pr_open', 'needs_reconciliation', 'closed', 'merged')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_pr_status ON live_pr_operations(status);

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'call')),
  recipient TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  message_text TEXT NOT NULL,
  approver TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'sent', 'unknown', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, request_id, recipient, content_hash)
);
